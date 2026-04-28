#!/usr/bin/env python3
"""Backfill vector embeddings for preserve tables and embedding_index.

Reads rows with NULL embedding, calls the local embed endpoint in batches,
and writes the resulting 384-dim vectors back to PostgreSQL.
"""

import argparse
import hashlib
import json
import sys
import os
import re
import time
import uuid
from urllib.parse import urlsplit, urlunsplit
import psycopg
import requests
import numpy as np
from pgvector.psycopg import register_vector

DSN = os.environ.get("BRAINCORE_POSTGRES_DSN")
if not DSN:
    raise SystemExit("BRAINCORE_POSTGRES_DSN is not set")
EMBED_URL = os.environ.get("BRAINCORE_EMBED_URL", "http://localhost:8900/embed")
BRAINCORE_EMBED_AUTH_TOKEN = os.environ.get("BRAINCORE_EMBED_AUTH_TOKEN", "")
BATCH_SIZE = 32
EMBED_RATE_LIMIT_PER_MINUTE = float(
    os.environ.get("BRAINCORE_EMBED_RATE_LIMIT_PER_MINUTE", "30")
)
EMBED_RATE_LIMIT_SAFETY_SECONDS = float(
    os.environ.get("BRAINCORE_EMBED_RATE_LIMIT_SAFETY_SECONDS", "0.1")
)
EMBED_MIN_INTERVAL_SECONDS = float(
    os.environ.get(
        "BRAINCORE_EMBED_MIN_INTERVAL_SECONDS",
        str(
            (60.0 / EMBED_RATE_LIMIT_PER_MINUTE) + EMBED_RATE_LIMIT_SAFETY_SECONDS
            if EMBED_RATE_LIMIT_PER_MINUTE > 0
            else 0.0
        ),
    )
)
EMBED_MAX_RETRIES = int(os.environ.get("BRAINCORE_EMBED_MAX_RETRIES", "5"))
EMBED_RETRY_BASE_SECONDS = float(
    os.environ.get(
        "BRAINCORE_EMBED_RETRY_BASE_SECONDS",
        str(max(EMBED_MIN_INTERVAL_SECONDS, 1.0)),
    )
)
EMBED_RETRY_MAX_SECONDS = float(
    os.environ.get("BRAINCORE_EMBED_RETRY_MAX_SECONDS", "60")
)
EMBEDDING_MODEL = os.environ.get("BRAINCORE_EMBED_MODEL", "braincore-minilm-v1")
TENANT = os.environ.get("BRAINCORE_TENANT", "default")

_last_embed_request_at = 0.0


class EmbeddingBackfillError(RuntimeError):
    """Raised for embed endpoint failures that must fail the nightly step."""


SECRET_PATTERNS = [
    (re.compile(r"(?:AWS_SECRET_ACCESS_KEY|aws_secret_access_key)\s*[:=]\s*['\"]?([a-zA-Z0-9/+=]{30,})['\"]?", re.I), "[REDACTED:aws_secret]"),
    (re.compile(r"(?:api[_-]?key|apikey|client[_-]?secret|access[_-]?key|credential)\s*[:=]\s*['\"]?([a-zA-Z0-9_\-./+=]{16,})['\"]?", re.I), "[REDACTED:api_key]"),
    (re.compile(r"(?:password|passwd|pwd)\s*[:=]\s*['\"]?([^\s'\"]{8,})['\"]?", re.I), "[REDACTED:password]"),
    (re.compile(r"(?:token|secret)\s*[:=]\s*['\"]?([a-zA-Z0-9_\-.]{20,})['\"]?", re.I), "[REDACTED:token]"),
    (re.compile(r"(?:authorization\s*:\s*)?bearer\s+[a-zA-Z0-9._\-]{20,}", re.I), "[REDACTED:bearer_token]"),
    (re.compile(r"\beyJ[a-zA-Z0-9_\-]+?\.[a-zA-Z0-9_\-]+?\.[a-zA-Z0-9_\-]+"), "[REDACTED:jwt]"),
    (re.compile(r"(?:session(?:id)?|cookie|refresh[_-]?token)\s*[:=]\s*['\"]?([^\s'\";]{16,})['\"]?", re.I), "[REDACTED:session_secret]"),
    (re.compile(r"-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----"), "[REDACTED:private_key]"),
    (re.compile(r"(?:postgresql|mysql|mongodb|redis):\/\/[^\s]+", re.I), "[REDACTED:connection_string]"),
    (re.compile(r"(?:sk-|pk_live_|pk_test_|sk_live_|sk_test_|ghp_|gho_|github_pat_|xox[baprs]-|ya29\.|hf_[A-Za-z0-9]{20,}|glpat-|sg\.[A-Za-z0-9._-]{20,})[a-zA-Z0-9_\-\.]{10,}"), "[REDACTED:vendor_key]"),
    (re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"), "[REDACTED:aws_access_key]"),
    (re.compile(r"\"(?:type)\"\s*:\s*\"service_account\"[\s\S]{0,250}?\"private_key_id\"\s*:\s*\"[^\"]{16,}\"[\s\S]{0,250}?\"client_email\"\s*:\s*\"[^\"]+@[^\"]+\.iam\.gserviceaccount\.com\""), "[REDACTED:google_service_account]"),
    (re.compile(r"\bhttps:\/\/hooks\.slack\.com\/services\/[A-Z0-9]{8,}\/[A-Z0-9]{8,}\/[A-Za-z0-9]{20,}\b"), "[REDACTED:slack_webhook]"),
    (re.compile(r"\bhttps:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d{17,20}\/[A-Za-z0-9._-]{40,}\b"), "[REDACTED:discord_webhook]"),
    (re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b"), "[REDACTED:telegram_bot_token]"),
    (re.compile(r"\bnpm_[A-Za-z0-9]{36}\b"), "[REDACTED:npm_token]"),
    (re.compile(r"\"auth\"\s*:\s*\"[A-Za-z0-9+/=]{20,}\""), "[REDACTED:docker_auth]"),
    (re.compile(r"machine\s+\S+\s+login\s+\S+\s+password\s+\S+", re.I), "[REDACTED:netrc]"),
    (re.compile(r"\b[A-Za-z0-9+/]{40,}={0,2}\b"), "[REDACTED:high_entropy]"),
]


def redact_text(text: str) -> str:
    redacted = text
    for pattern, replacement in SECRET_PATTERNS:
        redacted = pattern.sub(replacement, redacted)
    return redacted


def pace_embed_request(monotonic=time.monotonic, sleep=time.sleep) -> None:
    """Throttle embed requests so backfill stays below the embed service limit."""
    global _last_embed_request_at

    now = monotonic()
    if _last_embed_request_at and EMBED_MIN_INTERVAL_SECONDS > 0:
        elapsed = now - _last_embed_request_at
        if elapsed < EMBED_MIN_INTERVAL_SECONDS:
            sleep(EMBED_MIN_INTERVAL_SECONDS - elapsed)
            now = monotonic()

    _last_embed_request_at = now


def retry_after_seconds(resp) -> float | None:
    retry_after = resp.headers.get("Retry-After")
    if retry_after is None:
        return None

    try:
        return max(float(retry_after), 0.0)
    except ValueError:
        return None


def embed_retry_delay(resp, attempt: int) -> float:
    retry_after = retry_after_seconds(resp)
    if retry_after is not None:
        return retry_after

    return min(EMBED_RETRY_BASE_SECONDS * (2**attempt), EMBED_RETRY_MAX_SECONDS)


def auth_headers() -> dict[str, str]:
    if not BRAINCORE_EMBED_AUTH_TOKEN:
        return {}
    return {"Authorization": f"Bearer {BRAINCORE_EMBED_AUTH_TOKEN}"}


def embed_health_url() -> str:
    parsed = urlsplit(EMBED_URL)
    return urlunsplit((parsed.scheme, parsed.netloc, "/health", "", ""))


def check_embed_health(get=requests.get) -> dict:
    url = embed_health_url()
    try:
        resp = get(url, timeout=10)
    except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
        raise EmbeddingBackfillError(f"SERVICE_UNAVAILABLE: embed health endpoint unreachable: {e}") from e
    except requests.exceptions.RequestException as e:
        raise EmbeddingBackfillError(f"REQUEST_ERROR: embed health check failed: {e}") from e

    if resp.status_code >= 500:
        raise EmbeddingBackfillError(
            f"SERVICE_UNAVAILABLE: embed health endpoint returned HTTP {resp.status_code}: {resp.text[:200]}"
        )

    try:
        resp.raise_for_status()
    except requests.exceptions.HTTPError as e:
        raise EmbeddingBackfillError(
            f"HTTP_ERROR: embed health endpoint returned HTTP {resp.status_code}: {resp.text[:200]}"
        ) from e

    data = resp.json()
    if data.get("embedder") is False:
        raise EmbeddingBackfillError("SERVICE_UNAVAILABLE: embed health reports embedder=false")
    return data


def pending_embedding_counts(conn) -> dict[str, int]:
    counts = {}
    cur = conn.cursor()
    for table, _id_col, _text_expr, label in TABLES:
        cur.execute(f"SELECT count(*) FROM preserve.{table} WHERE embedding IS NULL")
        counts[label] = cur.fetchone()[0]
    return counts


def format_seconds(seconds: float) -> str:
    seconds = int(round(seconds))
    minutes, sec = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes}m {sec}s"
    if minutes:
        return f"{minutes}m {sec}s"
    return f"{sec}s"


def print_preflight(conn) -> None:
    health = check_embed_health()
    counts = pending_embedding_counts(conn)
    total = sum(counts.values())
    batches = (total + BATCH_SIZE - 1) // BATCH_SIZE
    estimated_seconds = max(0, batches - 1) * EMBED_MIN_INTERVAL_SECONDS
    detail = ", ".join(f"{label}={count}" for label, count in counts.items())

    print(
        "[preflight] embed service: "
        f"status={health.get('status', 'unknown')} "
        f"embedder={health.get('embedder', 'unknown')}"
    )
    print(
        "[preflight] embed rate: "
        f"client_limit={EMBED_RATE_LIMIT_PER_MINUTE:g}/min "
        f"min_interval={EMBED_MIN_INTERVAL_SECONDS:.2f}s "
        f"batch_size={BATCH_SIZE} retries={EMBED_MAX_RETRIES}"
    )
    print(
        "[preflight] pending embeddings: "
        f"total={total} batches={batches} estimated_min_runtime={format_seconds(estimated_seconds)}"
    )
    print(f"[preflight] pending by table: {detail}")


def embed_batch(
    texts: list[str],
    post=requests.post,
    sleep=time.sleep,
    monotonic=time.monotonic,
) -> list[list[float]]:
    """Send a batch of texts to the embed endpoint and return embeddings."""
    headers = auth_headers()

    for attempt in range(EMBED_MAX_RETRIES + 1):
        pace_embed_request(monotonic=monotonic, sleep=sleep)

        try:
            resp = post(EMBED_URL, json={"texts": texts}, headers=headers, timeout=60)
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            raise EmbeddingBackfillError(f"SERVICE_UNAVAILABLE: embed endpoint unreachable: {e}") from e
        except requests.exceptions.RequestException as e:
            raise EmbeddingBackfillError(f"REQUEST_ERROR: embed endpoint request failed: {e}") from e

        if resp.status_code == 429 and attempt < EMBED_MAX_RETRIES:
            delay = max(embed_retry_delay(resp, attempt), EMBED_MIN_INTERVAL_SECONDS)
            print(
                "  [embed] HTTP 429 rate limited; "
                f"retry {attempt + 1}/{EMBED_MAX_RETRIES} in {delay:.1f}s",
                file=sys.stderr,
            )
            sleep(delay)
            continue
        if resp.status_code == 429:
            retry_after = retry_after_seconds(resp)
            retry_detail = f" retry_after={retry_after:.1f}s" if retry_after is not None else ""
            raise EmbeddingBackfillError(
                "RATE_LIMITED: embed endpoint returned HTTP 429 "
                f"after {EMBED_MAX_RETRIES} retries;{retry_detail} body={resp.text[:200]}"
            )

        if resp.status_code == 401:
            raise EmbeddingBackfillError("AUTH_ERROR: embed endpoint rejected credentials (HTTP 401)")
        if resp.status_code >= 500:
            raise EmbeddingBackfillError(
                f"SERVICE_UNAVAILABLE: embed endpoint returned HTTP {resp.status_code}: {resp.text[:200]}"
            )

        try:
            resp.raise_for_status()
        except requests.exceptions.HTTPError as e:
            raise EmbeddingBackfillError(
                f"HTTP_ERROR: embed endpoint returned HTTP {resp.status_code}: {resp.text[:200]}"
            ) from e

        return resp.json()["embeddings"]

    raise RuntimeError("unreachable embed retry state")


def backfill_table(conn, table: str, id_col: str, text_expr: str, label: str) -> int:
    """Backfill embeddings for a single table. Returns count of rows updated."""
    cur = conn.cursor()
    cur.execute(
        f"SELECT {id_col}, {text_expr} FROM preserve.{table} WHERE embedding IS NULL"
    )
    rows = cur.fetchall()
    total = len(rows)
    print(f"[{label}] {total} rows need embeddings")

    if total == 0:
        return 0

    updated = 0
    for i in range(0, total, BATCH_SIZE):
        batch = rows[i : i + BATCH_SIZE]
        ids = [r[0] for r in batch]
        # Ensure texts are non-None strings, truncate very long ones to 8K chars
        texts = [redact_text((str(r[1]) if r[1] else "")[:8000]) for r in batch]

        try:
            embeddings = embed_batch(texts)
        except EmbeddingBackfillError as e:
            print(f"  [{label}] ERROR at batch {i}: {e}", file=sys.stderr)
            conn.rollback()
            raise

        for row_id, emb in zip(ids, embeddings):
            emb_np = np.array(emb, dtype=np.float32)
            cur.execute(
                f"UPDATE preserve.{table} SET embedding = %s WHERE {id_col} = %s",
                (emb_np, row_id),
            )
        conn.commit()
        updated += len(batch)
        print(f"  [{label}] {min(i + BATCH_SIZE, total)}/{total}")

    print(f"[{label}] done -- {updated} rows updated")
    return updated


TABLES = [
    ("segment", "segment_id", "content", "Segments"),
    ("fact", "fact_id", "predicate || ' ' || coalesce(object_value::text, '')", "Facts"),
    ("memory", "memory_id", "coalesce(title, '') || ' ' || coalesce(narrative, '')", "Memories"),
    ("entity", "entity_id", "canonical_name || ' ' || coalesce(aliases::text, '')", "Entities"),
    ("episode", "episode_id", "coalesce(title, '') || ' ' || coalesce(summary, '')", "Episodes"),
]

TARGET_ID_COLUMN = {
    "artifact": "artifact_id",
    "segment": "segment_id",
    "entity": "entity_id",
    "fact": "fact_id",
    "memory": "memory_id",
    "media_artifact": "media_artifact_id",
    "visual_region": "visual_region_id",
    "event_frame": "event_frame_id",
    "procedure": "procedure_id",
}

INDEX_ROLE_SPECS = {
    "text": {
        "target_kind": "segment",
        "target_column": "segment_id",
        "select": """
            SELECT
              s.segment_id::text AS target_id,
              s.content AS text,
              s.artifact_id::text AS source_artifact_id,
              s.segment_id::text AS source_segment_id
            FROM preserve.segment s
            WHERE s.tenant = %s
              AND length(trim(s.content)) > 0
              AND NOT EXISTS (
                SELECT 1 FROM preserve.embedding_index ei
                WHERE ei.tenant = s.tenant
                  AND ei.target_kind = 'segment'
                  AND ei.vector_role = 'text'
                  AND ei.segment_id = s.segment_id
              )
            ORDER BY s.created_at, s.segment_id
            LIMIT %s
        """,
    },
    "evidence": {
        "target_kind": "fact",
        "target_column": "fact_id",
        "select": """
            SELECT
              f.fact_id::text AS target_id,
              COALESCE(fe.excerpt, f.predicate || ' ' || COALESCE(f.object_value::text, '')) AS text,
              s.artifact_id::text AS source_artifact_id,
              fe.segment_id::text AS source_segment_id
            FROM preserve.fact f
            JOIN preserve.fact_evidence fe ON fe.fact_id = f.fact_id
            LEFT JOIN preserve.segment s ON s.segment_id = fe.segment_id
            WHERE f.tenant = %s
              AND length(trim(COALESCE(fe.excerpt, f.predicate, ''))) > 0
              AND NOT EXISTS (
                SELECT 1 FROM preserve.embedding_index ei
                WHERE ei.tenant = f.tenant
                  AND ei.target_kind = 'fact'
                  AND ei.vector_role = 'evidence'
                  AND ei.fact_id = f.fact_id
              )
            ORDER BY fe.created_at, f.fact_id
            LIMIT %s
        """,
    },
    "procedure": {
        "target_kind": "procedure",
        "target_column": "procedure_id",
        "select": """
            SELECT
              p.procedure_id::text AS target_id,
              trim(COALESCE(p.title, '') || ' ' || COALESCE(p.summary, '')) AS text,
              NULL::text AS source_artifact_id,
              p.evidence_segment_id::text AS source_segment_id
            FROM preserve.procedure p
            WHERE p.tenant = %s
              AND length(trim(COALESCE(p.title, '') || ' ' || COALESCE(p.summary, ''))) > 0
              AND COALESCE(p.lifecycle_state::text, 'draft') != 'retired'
              AND NOT EXISTS (
                SELECT 1 FROM preserve.embedding_index ei
                WHERE ei.tenant = p.tenant
                  AND ei.target_kind = 'procedure'
                  AND ei.vector_role = 'procedure'
                  AND ei.procedure_id = p.procedure_id
              )
            ORDER BY p.updated_at, p.procedure_id
            LIMIT %s
        """,
    },
    "media_caption": {
        "target_kind": "media_artifact",
        "target_column": "media_artifact_id",
        "select": """
            SELECT
              ma.media_artifact_id::text AS target_id,
              COALESCE(
                ma.media_meta->>'caption',
                ma.media_meta->>'description',
                ma.media_meta->>'title',
                ma.media_meta->>'alt_text'
              ) AS text,
              ma.artifact_id::text AS source_artifact_id,
              ma.source_segment_id::text AS source_segment_id
            FROM preserve.media_artifact ma
            WHERE ma.tenant = %s
              AND length(trim(COALESCE(
                ma.media_meta->>'caption',
                ma.media_meta->>'description',
                ma.media_meta->>'title',
                ma.media_meta->>'alt_text',
                ''
              ))) > 0
              AND NOT EXISTS (
                SELECT 1 FROM preserve.embedding_index ei
                WHERE ei.tenant = ma.tenant
                  AND ei.target_kind = 'media_artifact'
                  AND ei.vector_role = 'media_caption'
                  AND ei.media_artifact_id = ma.media_artifact_id
              )
            ORDER BY ma.created_at, ma.media_artifact_id
            LIMIT %s
        """,
    },
    "visual_ocr": {
        "target_kind": "visual_region",
        "target_column": "visual_region_id",
        "select": """
            SELECT
              vr.visual_region_id::text AS target_id,
              COALESCE(vr.region_meta->>'ocr_text', vr.region_meta->>'text') AS text,
              ma.artifact_id::text AS source_artifact_id,
              COALESCE(vr.source_segment_id, ma.source_segment_id)::text AS source_segment_id
            FROM preserve.visual_region vr
            JOIN preserve.media_artifact ma
              ON ma.tenant = vr.tenant
             AND ma.media_artifact_id = vr.media_artifact_id
            WHERE vr.tenant = %s
              AND length(trim(COALESCE(vr.region_meta->>'ocr_text', vr.region_meta->>'text', ''))) > 0
              AND NOT EXISTS (
                SELECT 1 FROM preserve.embedding_index ei
                WHERE ei.tenant = vr.tenant
                  AND ei.target_kind = 'visual_region'
                  AND ei.vector_role = 'visual_ocr'
                  AND ei.visual_region_id = vr.visual_region_id
              )
            ORDER BY vr.created_at, vr.visual_region_id
            LIMIT %s
        """,
    },
    "visual_caption": {
        "target_kind": "visual_region",
        "target_column": "visual_region_id",
        "select": """
            SELECT
              vr.visual_region_id::text AS target_id,
              COALESCE(vr.region_meta->>'caption', vr.label) AS text,
              ma.artifact_id::text AS source_artifact_id,
              COALESCE(vr.source_segment_id, ma.source_segment_id)::text AS source_segment_id
            FROM preserve.visual_region vr
            JOIN preserve.media_artifact ma
              ON ma.tenant = vr.tenant
             AND ma.media_artifact_id = vr.media_artifact_id
            WHERE vr.tenant = %s
              AND length(trim(COALESCE(vr.region_meta->>'caption', vr.label, ''))) > 0
              AND NOT EXISTS (
                SELECT 1 FROM preserve.embedding_index ei
                WHERE ei.tenant = vr.tenant
                  AND ei.target_kind = 'visual_region'
                  AND ei.vector_role = 'visual_caption'
                  AND ei.visual_region_id = vr.visual_region_id
              )
            ORDER BY vr.created_at, vr.visual_region_id
            LIMIT %s
        """,
    },
}


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def embedding_index_fingerprint(
    tenant: str,
    target_kind: str,
    target_id: str,
    vector_role: str,
    input_sha256: str,
    model: str,
) -> str:
    return sha256_hex(
        "|".join(
            [
                "embedding-index-v1",
                f"tenant={tenant.strip().lower()}",
                f"target={target_kind}:{str(target_id).strip().lower()}",
                f"role={vector_role}",
                f"input={input_sha256}",
                f"model={model}",
                "dim=384",
            ]
        )
    )


def is_zero_vector(vector) -> bool:
    arr = np.array(vector, dtype=np.float32)
    values = arr.tolist() if hasattr(arr, "tolist") else arr
    return all(float(value) == 0.0 for value in values)


def fetch_embedding_index_candidates(conn, role: str, tenant: str, limit: int) -> list[dict]:
    spec = INDEX_ROLE_SPECS[role]
    cur = conn.cursor()
    cur.execute(spec["select"], (tenant, limit))
    rows = cur.fetchall()
    candidates = []
    for row in rows:
        target_id, text, source_artifact_id, source_segment_id = row
        safe_text = redact_text((str(text) if text else "")[:8000])
        if not safe_text.strip():
            continue
        input_sha256 = sha256_hex(safe_text)
        candidates.append(
            {
                "target_id": str(target_id),
                "target_kind": spec["target_kind"],
                "target_column": spec["target_column"],
                "vector_role": role,
                "text": safe_text,
                "source_artifact_id": source_artifact_id,
                "source_segment_id": source_segment_id,
                "input_sha256": input_sha256,
                "embedding_fingerprint": embedding_index_fingerprint(
                    tenant,
                    spec["target_kind"],
                    str(target_id),
                    role,
                    input_sha256,
                    EMBEDDING_MODEL,
                ),
            }
        )
    return candidates


def insert_embedding_index_candidate(
    conn,
    tenant: str,
    candidate: dict,
    embedding,
    embedding_run_id: str,
) -> bool:
    target_column = candidate["target_column"]
    cur = conn.cursor()
    embedding_meta = {
        "source": "scripts/backfill-embeddings.py",
        "mode": "embedding_index",
        "embedding_run_id": embedding_run_id,
    }
    cur.execute(
        f"""
        INSERT INTO preserve.embedding_index (
          tenant,
          target_kind,
          vector_role,
          embedding_model,
          embedding_dimension,
          embedding,
          embedding_fingerprint,
          {target_column},
          source_artifact_id,
          source_segment_id,
          input_sha256,
          embedding_meta
        )
        VALUES (
          %s, %s, %s, %s, 384, %s, %s, %s, %s, %s, %s,
          %s::jsonb
        )
        ON CONFLICT (tenant, embedding_fingerprint) DO NOTHING
        RETURNING embedding_id
        """,
        (
            tenant,
            candidate["target_kind"],
            candidate["vector_role"],
            EMBEDDING_MODEL,
            np.array(embedding, dtype=np.float32),
            candidate["embedding_fingerprint"],
            candidate["target_id"],
            candidate["source_artifact_id"],
            candidate["source_segment_id"],
            candidate["input_sha256"],
            json.dumps(embedding_meta, sort_keys=True),
        ),
    )
    return cur.fetchone() is not None


def populate_embedding_index(
    conn,
    roles: list[str],
    tenant: str = TENANT,
    limit: int = 100,
    dry_run: bool = False,
    embedding_run_id: str | None = None,
) -> dict[str, dict[str, int]]:
    embedding_run_id = embedding_run_id or str(uuid.uuid4())
    results: dict[str, dict[str, int]] = {}
    for role in roles:
        if role not in INDEX_ROLE_SPECS:
            raise EmbeddingBackfillError(f"Unknown embedding_index role: {role}")
        candidates = fetch_embedding_index_candidates(conn, role, tenant, limit)
        results[role] = {
            "proposed": len(candidates),
            "inserted": 0,
            "skipped_zero": 0,
            "skipped_unavailable": 0,
        }
        print(f"[embedding_index:{role}] proposed={len(candidates)} dry_run={dry_run}")
        if dry_run or not candidates:
            continue

        for i in range(0, len(candidates), BATCH_SIZE):
            batch = candidates[i : i + BATCH_SIZE]
            try:
                embeddings = embed_batch([candidate["text"] for candidate in batch])
            except EmbeddingBackfillError as e:
                print(
                    f"  [embedding_index:{role}] embed unavailable at batch {i}; "
                    f"skipping vector insertion for {len(batch)} candidates: {e}",
                    file=sys.stderr,
                )
                results[role]["skipped_unavailable"] += len(batch)
                conn.rollback()
                continue

            for candidate, embedding in zip(batch, embeddings):
                if is_zero_vector(embedding):
                    results[role]["skipped_zero"] += 1
                    continue
                if insert_embedding_index_candidate(
                    conn,
                    tenant,
                    candidate,
                    embedding,
                    embedding_run_id,
                ):
                    results[role]["inserted"] += 1
            conn.commit()
    return results


def rollback_embedding_index_run(
    conn,
    tenant: str,
    embedding_run_id: str,
    limit: int = 100,
    dry_run: bool = False,
) -> dict[str, int]:
    cur = conn.cursor()
    cur.execute(
        """
        SELECT count(*)
        FROM preserve.embedding_index
        WHERE tenant = %s
          AND embedding_meta->>'embedding_run_id' = %s
        """,
        (tenant, embedding_run_id),
    )
    proposed = min(int(cur.fetchone()[0]), limit)
    result = {"proposed": proposed, "deleted": 0}
    if dry_run:
        return result

    cur.execute(
        """
        WITH doomed AS (
          SELECT embedding_id
          FROM preserve.embedding_index
          WHERE tenant = %s
            AND embedding_meta->>'embedding_run_id' = %s
          ORDER BY created_at DESC, embedding_id
          LIMIT %s
        )
        DELETE FROM preserve.embedding_index ei
        USING doomed
        WHERE ei.embedding_id = doomed.embedding_id
        RETURNING ei.embedding_id
        """,
        (tenant, embedding_run_id, limit),
    )
    result["deleted"] = len(cur.fetchall())
    conn.commit()
    return result


def main():
    parser = argparse.ArgumentParser(
        description="Backfill table embeddings or populate preserve.embedding_index."
    )
    parser.add_argument(
        "--embedding-index",
        action="store_true",
        help="Populate preserve.embedding_index roles instead of legacy embedding columns.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report embedding_index candidates without calling the embed service or writing rows.",
    )
    parser.add_argument(
        "--roles",
        default=",".join(INDEX_ROLE_SPECS.keys()),
        help="Comma-separated embedding_index roles to populate.",
    )
    parser.add_argument(
        "--tenant",
        default=TENANT,
        help="Tenant to populate for embedding_index mode.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=100,
        help="Maximum candidates per role in embedding_index mode.",
    )
    parser.add_argument(
        "--embedding-run-id",
        default=str(uuid.uuid4()),
        help="Batch anchor stored in embedding_index.embedding_meta for rollback.",
    )
    parser.add_argument(
        "--rollback-embedding-run-id",
        help="Delete embedding_index rows from one anchored embedding run.",
    )
    args = parser.parse_args()

    if args.rollback_embedding_run_id and not args.embedding_index:
        parser.error("--rollback-embedding-run-id requires --embedding-index")

    print("Connecting to PostgreSQL...")
    conn = psycopg.connect(DSN)
    register_vector(conn)

    t0 = time.time()

    if args.embedding_index:
        if args.rollback_embedding_run_id:
            result = rollback_embedding_index_run(
                conn,
                tenant=args.tenant,
                embedding_run_id=args.rollback_embedding_run_id,
                limit=args.limit,
                dry_run=args.dry_run,
            )
            conn.close()
            print("=" * 50)
            print("EMBEDDING_INDEX ROLLBACK COMPLETE")
            print("=" * 50)
            print(
                f"  embedding_run_id: {args.rollback_embedding_run_id} "
                f"proposed={result['proposed']} deleted={result['deleted']} "
                f"dry_run={args.dry_run}"
            )
            print("=" * 50)
            return

        roles = [role.strip() for role in args.roles.split(",") if role.strip()]
        print("Connected. Populating embedding_index roles...\n")
        results = populate_embedding_index(
            conn,
            roles=roles,
            tenant=args.tenant,
            limit=args.limit,
            dry_run=args.dry_run,
            embedding_run_id=args.embedding_run_id,
        )
        conn.close()
        elapsed = time.time() - t0

        print("=" * 50)
        print("EMBEDDING_INDEX BACKFILL COMPLETE")
        print("=" * 50)
        total_inserted = 0
        for role, counts in results.items():
            total_inserted += counts["inserted"]
            print(
                f"  {role}: proposed={counts['proposed']} "
                f"inserted={counts['inserted']} "
                f"skipped_zero={counts['skipped_zero']} "
                f"skipped_unavailable={counts['skipped_unavailable']}"
            )
        print(f"  Embedding run id: {args.embedding_run_id}")
        print(f"  Total inserted: {total_inserted}")
        print(f"  Elapsed: {elapsed:.1f}s")
        print("=" * 50)
        return

    print("Connected. Running preflight...\n")
    print_preflight(conn)
    print("\nStarting backfill...\n")

    results = {}

    for table, id_col, text_expr, label in TABLES:
        count = backfill_table(conn, table, id_col, text_expr, label)
        results[label] = count
        print()

    conn.close()
    elapsed = time.time() - t0

    print("=" * 50)
    print("BACKFILL COMPLETE")
    print("=" * 50)
    for label, count in results.items():
        print(f"  {label}: {count} embeddings generated")
    print(f"  Total: {sum(results.values())} embeddings")
    print(f"  Elapsed: {elapsed:.1f}s")
    print("=" * 50)


if __name__ == "__main__":
    try:
        main()
    except EmbeddingBackfillError as e:
        print(f"Embedding backfill failed: {e}", file=sys.stderr)
        sys.exit(1)
