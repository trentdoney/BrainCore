#!/usr/bin/env python3
"""Tag milestone facts based on keywords and compute importance scores."""
import psycopg

import os
DSN = os.environ.get("BRAINCORE_POSTGRES_DSN", "postgresql://braincore:braincore@localhost:5432/braincore")
conn = psycopg.connect(DSN)
cur = conn.cursor()

MILESTONE_KEYWORDS = [
    'migrat', 'deploy', 'upgrad', 'replac', 'new service', 'launch',
    'v2', 'v3', 'phase', 'cutover', 'install', 'security fix',
    'architecture', 'major', 'critical'
]

# Tag facts matching milestone keywords in predicate or object_value
conditions = " OR ".join([
    f"LOWER(f.predicate) LIKE '%{kw}%' OR LOWER(COALESCE(f.object_value::text, '')) LIKE '%{kw}%'"
    for kw in MILESTONE_KEYWORDS
])

cur.execute(f"""
    UPDATE preserve.fact f SET is_milestone = TRUE
    WHERE ({conditions})
    AND f.is_milestone = FALSE
""")
print(f"Tagged {cur.rowcount} milestone facts (keyword match)")

# Also tag facts from critical/major episodes
cur.execute("""
    UPDATE preserve.fact f SET is_milestone = TRUE
    FROM preserve.episode ep
    WHERE f.episode_id = ep.episode_id
    AND ep.severity IN ('critical', 'major', 'P1', 'P2')
    AND f.is_milestone = FALSE
""")
print(f"Tagged {cur.rowcount} facts from critical episodes")

conn.commit()

# Compute importance scores (with episode join)
cur.execute("""
    UPDATE preserve.fact f SET importance_score = LEAST(100,
      CASE WHEN f.is_milestone THEN 50 ELSE 0 END
      + CASE WHEN f.assertion_class = 'deterministic' THEN 10 WHEN f.assertion_class = 'corroborated_llm' THEN 15 ELSE 0 END
      + CASE WHEN ep.severity IN ('critical','P1') THEN 20
             WHEN ep.severity IN ('major','P2') THEN 10
             ELSE 0 END
      + GREATEST(0, 20 - EXTRACT(DAY FROM now() - f.created_at) * 0.1)
    )
    FROM preserve.episode ep
    WHERE f.episode_id = ep.episode_id
""")
print(f"Updated importance scores on {cur.rowcount} facts (with episodes)")

# Also score facts without episodes (just milestone + assertion + recency)
cur.execute("""
    UPDATE preserve.fact f SET importance_score = LEAST(100,
      CASE WHEN f.is_milestone THEN 50 ELSE 0 END
      + CASE WHEN f.assertion_class = 'deterministic' THEN 10 WHEN f.assertion_class = 'corroborated_llm' THEN 15 ELSE 0 END
      + GREATEST(0, 20 - EXTRACT(DAY FROM now() - f.created_at) * 0.1)
    )
    WHERE f.episode_id IS NULL
""")
print(f"Updated importance scores on {cur.rowcount} facts (no episode)")

conn.commit()

# Report
cur.execute("SELECT count(*) FROM preserve.fact WHERE is_milestone = TRUE")
print(f"Total milestones: {cur.fetchone()[0]}")
cur.execute("SELECT avg(importance_score), max(importance_score) FROM preserve.fact")
avg, mx = cur.fetchone()
print(f"Importance: avg={avg:.1f}, max={mx:.1f}")

conn.close()
