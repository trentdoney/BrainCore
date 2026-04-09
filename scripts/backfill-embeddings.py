#!/usr/bin/env python3
"""Backfill vector embeddings for all preserve tables.

Reads rows with NULL embedding, calls the local embed endpoint in batches,
and writes the resulting 384-dim vectors back to PostgreSQL.
"""

import sys
import os
import time
import psycopg
import requests
import numpy as np
from pgvector.psycopg import register_vector

DSN = os.environ.get("BRAINCORE_POSTGRES_DSN")
if not DSN:
    raise SystemExit("BRAINCORE_POSTGRES_DSN is not set")
EMBED_URL = os.environ.get("BRAINCORE_EMBED_URL", "http://localhost:8900/embed")
BATCH_SIZE = 32


def embed_batch(texts: list[str]) -> list[list[float]]:
    """Send a batch of texts to the embed endpoint and return embeddings."""
    resp = requests.post(EMBED_URL, json={"texts": texts}, timeout=60)
    resp.raise_for_status()
    return resp.json()["embeddings"]


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
        texts = [(str(r[1]) if r[1] else "") [:8000] for r in batch]

        try:
            embeddings = embed_batch(texts)
        except Exception as e:
            print(f"  [{label}] ERROR at batch {i}: {e}", file=sys.stderr)
            conn.rollback()
            continue

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


def main():
    print("Connecting to PostgreSQL...")
    conn = psycopg.connect(DSN)
    register_vector(conn)
    print("Connected. Starting backfill...\n")

    t0 = time.time()
    results = {}

    tables = [
        ("segment", "segment_id", "content", "Segments"),
        ("fact", "fact_id", "predicate || ' ' || coalesce(object_value::text, '')", "Facts"),
        ("memory", "memory_id", "coalesce(title, '') || ' ' || coalesce(narrative, '')", "Memories"),
        ("entity", "entity_id", "canonical_name || ' ' || coalesce(aliases::text, '')", "Entities"),
        ("episode", "episode_id", "coalesce(title, '') || ' ' || coalesce(summary, '')", "Episodes"),
    ]

    for table, id_col, text_expr, label in tables:
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
    main()
