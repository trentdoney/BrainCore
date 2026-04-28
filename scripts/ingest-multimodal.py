#!/usr/bin/env python3
"""Ingest multimodal metadata into preserve.media_artifact/visual_region.

The manifest format is newline-delimited JSON. Each row must reference an
existing preserve.artifact row by artifact_id. The script stores metadata only;
it does not copy files, expose raw artifact bytes, or run OCR/caption models.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row

DSN = os.environ.get("BRAINCORE_POSTGRES_DSN")
TENANT = os.environ.get("BRAINCORE_TENANT", "default")


class MultimodalIngestError(RuntimeError):
    """Raised for manifest or database errors that should fail the batch."""


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def normalize_bbox(region: dict[str, Any]) -> tuple[float, float, float, float]:
    bbox = region.get("bbox")
    if isinstance(bbox, dict):
        values = (bbox.get("x_min"), bbox.get("y_min"), bbox.get("x_max"), bbox.get("y_max"))
    elif isinstance(bbox, list) and len(bbox) == 4:
        values = tuple(bbox)
    else:
        values = (
            region.get("x_min", 0),
            region.get("y_min", 0),
            region.get("x_max", 1),
            region.get("y_max", 1),
        )

    try:
        x_min, y_min, x_max, y_max = [float(value) for value in values]
    except (TypeError, ValueError) as exc:
        raise MultimodalIngestError(f"Invalid bbox values: {values}") from exc

    if not (0 <= x_min < x_max and 0 <= y_min < y_max):
        raise MultimodalIngestError(f"Invalid bbox order/bounds: {values}")
    if region.get("coordinate_space", "normalized") == "normalized" and (x_max > 1 or y_max > 1):
        raise MultimodalIngestError(f"Normalized bbox exceeds 1.0: {values}")
    return x_min, y_min, x_max, y_max


def region_text(region: dict[str, Any]) -> str:
    return str(
        region.get("ocr_text")
        or region.get("caption")
        or region.get("text")
        or region.get("label")
        or ""
    )


def region_fingerprint(
    tenant: str,
    media_artifact_id: str,
    region: dict[str, Any],
) -> str:
    bbox = normalize_bbox(region)
    parts = [
        "visual-region-v1",
        tenant.strip().lower(),
        str(media_artifact_id).strip().lower(),
        str(region.get("page_number") or ""),
        str(region.get("region_type") or "text_block").strip().lower(),
        ",".join(f"{value:.6f}" for value in bbox),
        region_text(region).strip().lower(),
    ]
    return sha256_hex("|".join(parts))


def load_manifest(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                row = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise MultimodalIngestError(f"{path}:{line_no}: invalid JSON: {exc}") from exc
            if not isinstance(row, dict):
                raise MultimodalIngestError(f"{path}:{line_no}: row must be a JSON object")
            if not row.get("artifact_id"):
                raise MultimodalIngestError(f"{path}:{line_no}: artifact_id is required")
            if not row.get("media_type"):
                raise MultimodalIngestError(f"{path}:{line_no}: media_type is required")
            rows.append(row)
    return rows


def media_meta(row: dict[str, Any]) -> dict[str, Any]:
    meta = dict(row.get("media_meta") or {})
    for key in ("caption", "description", "title", "alt_text"):
        if row.get(key) is not None:
            meta[key] = row[key]
    return meta


def region_meta(region: dict[str, Any]) -> dict[str, Any]:
    meta = dict(region.get("region_meta") or {})
    for key in ("ocr_text", "caption", "text"):
        if region.get(key) is not None:
            meta[key] = region[key]
    return meta


def validate_artifacts_exist(cur, rows: list[dict[str, Any]], tenant: str) -> None:
    artifact_ids = sorted({str(row["artifact_id"]) for row in rows})
    if not artifact_ids:
        return

    cur.execute(
        """
        SELECT artifact_id::text AS artifact_id
        FROM preserve.artifact
        WHERE tenant = %s
          AND artifact_id = ANY(%s::uuid[])
        """,
        (tenant, artifact_ids),
    )
    found = {row["artifact_id"] for row in cur.fetchall()}
    missing = [artifact_id for artifact_id in artifact_ids if artifact_id not in found]
    if missing:
        preview = ", ".join(missing[:5])
        suffix = "" if len(missing) <= 5 else f", ... ({len(missing)} total)"
        raise MultimodalIngestError(
            f"Manifest references artifact_id values absent for tenant {tenant}: {preview}{suffix}"
        )


def upsert_media(cur, row: dict[str, Any], ingest_run_id: str, batch_key: str, tenant: str) -> str:
    sha256 = row.get("sha256") or sha256_hex(json.dumps(row, sort_keys=True))
    cur.execute(
        """
        INSERT INTO preserve.media_artifact (
          tenant, artifact_id, source_segment_id, project_entity_id,
          media_type, mime_type, sha256, width_px, height_px, duration_ms,
          page_count, scope_path, media_meta, ingest_run_id, ingest_batch_key
        )
        VALUES (
          %s, %s::uuid, %s::uuid, %s::uuid,
          %s, %s, %s, %s, %s, %s,
          %s, %s, %s::jsonb, %s::uuid, %s
        )
        ON CONFLICT (tenant, artifact_id) DO UPDATE SET
          source_segment_id = COALESCE(EXCLUDED.source_segment_id, preserve.media_artifact.source_segment_id),
          project_entity_id = COALESCE(EXCLUDED.project_entity_id, preserve.media_artifact.project_entity_id),
          media_type = EXCLUDED.media_type,
          mime_type = COALESCE(EXCLUDED.mime_type, preserve.media_artifact.mime_type),
          sha256 = EXCLUDED.sha256,
          width_px = COALESCE(EXCLUDED.width_px, preserve.media_artifact.width_px),
          height_px = COALESCE(EXCLUDED.height_px, preserve.media_artifact.height_px),
          duration_ms = COALESCE(EXCLUDED.duration_ms, preserve.media_artifact.duration_ms),
          page_count = COALESCE(EXCLUDED.page_count, preserve.media_artifact.page_count),
          scope_path = COALESCE(EXCLUDED.scope_path, preserve.media_artifact.scope_path),
          media_meta = preserve.media_artifact.media_meta || EXCLUDED.media_meta,
          ingest_run_id = EXCLUDED.ingest_run_id,
          ingest_batch_key = EXCLUDED.ingest_batch_key,
          updated_at = now()
        RETURNING media_artifact_id::text
        """,
        (
            tenant,
            row["artifact_id"],
            row.get("source_segment_id"),
            row.get("project_entity_id"),
            row["media_type"],
            row.get("mime_type"),
            sha256,
            row.get("width_px"),
            row.get("height_px"),
            row.get("duration_ms"),
            row.get("page_count"),
            row.get("scope_path"),
            json.dumps(media_meta(row), sort_keys=True),
            ingest_run_id,
            batch_key,
        ),
    )
    return cur.fetchone()["media_artifact_id"]


def upsert_region(
    cur,
    row: dict[str, Any],
    region: dict[str, Any],
    media_artifact_id: str,
    ingest_run_id: str,
    batch_key: str,
    tenant: str,
) -> None:
    x_min, y_min, x_max, y_max = normalize_bbox(region)
    cur.execute(
        """
        INSERT INTO preserve.visual_region (
          tenant, media_artifact_id, region_fingerprint, region_type,
          page_number, x_min, y_min, x_max, y_max, coordinate_space,
          label, source_segment_id, linked_entity_id, linked_fact_id,
          linked_memory_id, linked_event_frame_id, linked_procedure_id,
          confidence, assertion_class, region_meta, ingest_run_id,
          ingest_batch_key
        )
        VALUES (
          %s, %s::uuid, %s, %s,
          %s, %s, %s, %s, %s, %s,
          %s, %s::uuid, %s::uuid, %s::uuid,
          %s::uuid, %s::uuid, %s::uuid,
          %s, %s, %s::jsonb, %s::uuid,
          %s
        )
        ON CONFLICT (tenant, region_fingerprint) DO UPDATE SET
          region_type = EXCLUDED.region_type,
          page_number = EXCLUDED.page_number,
          x_min = EXCLUDED.x_min,
          y_min = EXCLUDED.y_min,
          x_max = EXCLUDED.x_max,
          y_max = EXCLUDED.y_max,
          coordinate_space = EXCLUDED.coordinate_space,
          label = COALESCE(EXCLUDED.label, preserve.visual_region.label),
          source_segment_id = COALESCE(EXCLUDED.source_segment_id, preserve.visual_region.source_segment_id),
          linked_entity_id = COALESCE(EXCLUDED.linked_entity_id, preserve.visual_region.linked_entity_id),
          linked_fact_id = COALESCE(EXCLUDED.linked_fact_id, preserve.visual_region.linked_fact_id),
          linked_memory_id = COALESCE(EXCLUDED.linked_memory_id, preserve.visual_region.linked_memory_id),
          linked_event_frame_id = COALESCE(EXCLUDED.linked_event_frame_id, preserve.visual_region.linked_event_frame_id),
          linked_procedure_id = COALESCE(EXCLUDED.linked_procedure_id, preserve.visual_region.linked_procedure_id),
          confidence = COALESCE(EXCLUDED.confidence, preserve.visual_region.confidence),
          assertion_class = COALESCE(EXCLUDED.assertion_class, preserve.visual_region.assertion_class),
          region_meta = preserve.visual_region.region_meta || EXCLUDED.region_meta,
          ingest_run_id = EXCLUDED.ingest_run_id,
          ingest_batch_key = EXCLUDED.ingest_batch_key,
          updated_at = now()
        """,
        (
            tenant,
            media_artifact_id,
            region.get("region_fingerprint") or region_fingerprint(tenant, media_artifact_id, region),
            region.get("region_type") or "text_block",
            region.get("page_number"),
            x_min,
            y_min,
            x_max,
            y_max,
            region.get("coordinate_space") or "normalized",
            region.get("label"),
            region.get("source_segment_id") or row.get("source_segment_id"),
            region.get("linked_entity_id"),
            region.get("linked_fact_id"),
            region.get("linked_memory_id"),
            region.get("linked_event_frame_id"),
            region.get("linked_procedure_id"),
            region.get("confidence"),
            region.get("assertion_class"),
            json.dumps(region_meta(region), sort_keys=True),
            ingest_run_id,
            batch_key,
        ),
    )


def ingest_manifest(
    conn,
    rows: list[dict[str, Any]],
    *,
    ingest_run_id: str,
    batch_key: str,
    tenant: str,
    dry_run: bool,
    limit: int,
) -> dict[str, int]:
    selected = rows[:limit]
    counts = {
        "proposed_media": len(selected),
        "proposed_regions": sum(len(row.get("regions") or []) for row in selected),
        "inserted_media": 0,
        "inserted_regions": 0,
    }

    with conn.cursor(row_factory=dict_row) as cur:
        validate_artifacts_exist(cur, selected, tenant)
        if dry_run:
            return counts

        for row in selected:
            media_artifact_id = upsert_media(cur, row, ingest_run_id, batch_key, tenant)
            counts["inserted_media"] += 1
            for region in row.get("regions") or []:
                upsert_region(cur, row, region, media_artifact_id, ingest_run_id, batch_key, tenant)
                counts["inserted_regions"] += 1
    conn.commit()
    return counts


def rollback_ingest(conn, *, ingest_run_id: str, tenant: str, limit: int, dry_run: bool) -> dict[str, int]:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            SELECT
              (SELECT count(*) FROM preserve.visual_region WHERE tenant = %s AND ingest_run_id = %s::uuid) AS regions,
              (SELECT count(*) FROM preserve.media_artifact WHERE tenant = %s AND ingest_run_id = %s::uuid) AS media
            """,
            (tenant, ingest_run_id, tenant, ingest_run_id),
        )
        proposed = cur.fetchone()
        counts = {
            "proposed_media": min(int(proposed["media"]), limit),
            "proposed_regions": min(int(proposed["regions"]), limit),
            "deleted_media": 0,
            "deleted_regions": 0,
        }
        if dry_run:
            return counts

        cur.execute(
            """
            WITH doomed AS (
              SELECT visual_region_id
              FROM preserve.visual_region
              WHERE tenant = %s AND ingest_run_id = %s::uuid
              ORDER BY created_at DESC
              LIMIT %s
            )
            DELETE FROM preserve.visual_region vr
            USING doomed
            WHERE vr.visual_region_id = doomed.visual_region_id
            RETURNING vr.visual_region_id
            """,
            (tenant, ingest_run_id, limit),
        )
        counts["deleted_regions"] = len(cur.fetchall())
        cur.execute(
            """
            WITH doomed AS (
              SELECT media_artifact_id
              FROM preserve.media_artifact
              WHERE tenant = %s AND ingest_run_id = %s::uuid
              ORDER BY created_at DESC
              LIMIT %s
            )
            DELETE FROM preserve.media_artifact ma
            USING doomed
            WHERE ma.media_artifact_id = doomed.media_artifact_id
            RETURNING ma.media_artifact_id
            """,
            (tenant, ingest_run_id, limit),
        )
        counts["deleted_media"] = len(cur.fetchall())
    conn.commit()
    return counts


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest multimodal metadata manifest rows.")
    parser.add_argument("--manifest", type=Path, help="JSONL manifest path")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--tenant", default=TENANT)
    parser.add_argument("--ingest-run-id", default=str(uuid.uuid4()))
    parser.add_argument("--batch-key", default="manual")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--rollback-ingest-run-id", help="Delete rows from one ingest run")
    return parser.parse_args()


def main() -> int:
    if not DSN:
        raise SystemExit("BRAINCORE_POSTGRES_DSN is not set")
    args = parse_args()
    limit = max(1, min(args.limit, 5000))
    with psycopg.connect(DSN) as conn:
        if args.rollback_ingest_run_id:
            result = rollback_ingest(
                conn,
                ingest_run_id=args.rollback_ingest_run_id,
                tenant=args.tenant,
                limit=limit,
                dry_run=args.dry_run,
            )
        else:
            if not args.manifest:
                raise MultimodalIngestError("--manifest is required unless rolling back")
            rows = load_manifest(args.manifest)
            result = ingest_manifest(
                conn,
                rows,
                ingest_run_id=args.ingest_run_id,
                batch_key=args.batch_key,
                tenant=args.tenant,
                dry_run=args.dry_run,
                limit=limit,
            )
    print(json.dumps({
        "tenant": args.tenant,
        "ingest_run_id": args.rollback_ingest_run_id or args.ingest_run_id,
        "dry_run": args.dry_run,
        **result,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except MultimodalIngestError as exc:
        print(f"multimodal ingest failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
