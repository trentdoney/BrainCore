#!/usr/bin/env python3
"""Backfill valid_from/valid_to on facts from episode dates."""
import os
import psycopg

DSN = os.environ.get("BRAINCORE_POSTGRES_DSN")
if not DSN:
    raise SystemExit("BRAINCORE_POSTGRES_DSN is not set")
conn = psycopg.connect(DSN)
cur = conn.cursor()

# Backfill valid_from from episode start_at
cur.execute("""
    UPDATE preserve.fact f
    SET valid_from = ep.start_at
    FROM preserve.episode ep
    WHERE f.episode_id = ep.episode_id
    AND f.valid_from IS NULL
    AND ep.start_at IS NOT NULL
""")
print(f"Set valid_from on {cur.rowcount} facts")

# Backfill valid_to for cause/impact facts from resolved episodes
cur.execute("""
    UPDATE preserve.fact f
    SET valid_to = ep.end_at
    FROM preserve.episode ep
    WHERE f.episode_id = ep.episode_id
    AND f.valid_to IS NULL
    AND ep.end_at IS NOT NULL
    AND ep.outcome IN ('resolved', 'closed')
    AND f.fact_kind IN ('cause', 'impact')
""")
print(f"Set valid_to on {cur.rowcount} cause/impact facts")

# Supersession detection: same subject+predicate, different value, overlapping
cur.execute("""
    UPDATE preserve.fact f1
    SET valid_to = f2.valid_from, current_status = 'superseded'
    FROM preserve.fact f2
    WHERE f1.subject_entity_id = f2.subject_entity_id
    AND f1.predicate = f2.predicate
    AND f1.fact_kind = f2.fact_kind
    AND f1.fact_id != f2.fact_id
    AND f1.valid_from IS NOT NULL AND f2.valid_from IS NOT NULL
    AND f1.valid_from < f2.valid_from
    AND (f1.valid_to IS NULL OR f1.valid_to > f2.valid_from)
    AND f1.current_status = 'active'
    AND f2.current_status = 'active'
    AND COALESCE(f1.object_value::text, '') != COALESCE(f2.object_value::text, '')
""")
print(f"Superseded {cur.rowcount} facts")

conn.commit()

# Verify: count facts with temporal bounds
cur.execute("SELECT count(*) FROM preserve.fact WHERE valid_from IS NOT NULL")
with_from = cur.fetchone()[0]
cur.execute("SELECT count(*) FROM preserve.fact WHERE valid_to IS NOT NULL")
with_to = cur.fetchone()[0]
cur.execute("SELECT count(*) FROM preserve.fact")
total = cur.fetchone()[0]
print(f"Temporal coverage: {with_from}/{total} have valid_from, {with_to}/{total} have valid_to")

conn.close()
