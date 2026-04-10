#!/usr/bin/env python3
"""Retroactively set priority on existing facts based on importance signals."""
import os
import psycopg

DSN = os.environ["BRAINCORE_POSTGRES_DSN"]
conn = psycopg.connect(DSN)
cur = conn.cursor()

# Priority 1: milestone facts inferred from existing importance scores
cur.execute("UPDATE preserve.fact SET priority = 1 WHERE importance_score >= 50 AND priority = 5")
print(f"Priority 1 (importance >= 50): {cur.rowcount}")

# Priority 2: facts from critical-severity episodes
cur.execute("""
    UPDATE preserve.fact f SET priority = 2
    FROM preserve.episode ep
    WHERE f.episode_id = ep.episode_id
    AND ep.severity IN ('critical', 'P1')
    AND f.priority = 5
""")
print(f"Priority 2 (critical episodes): {cur.rowcount}")

# Priority 3: corroborated_llm facts
cur.execute("UPDATE preserve.fact SET priority = 3 WHERE assertion_class = 'corroborated_llm' AND priority = 5")
print(f"Priority 3 (corroborated_llm): {cur.rowcount}")

# Priority 4: deterministic facts
cur.execute("UPDATE preserve.fact SET priority = 4 WHERE assertion_class = 'deterministic' AND priority = 5")
print(f"Priority 4 (deterministic): {cur.rowcount}")

# Same for artifacts and memory
cur.execute("UPDATE preserve.artifact SET priority = 2 WHERE source_type = 'opsvault_incident' AND priority = 5")
print(f"Artifact priority 2 (incidents): {cur.rowcount}")

cur.execute("""
    UPDATE preserve.memory m SET priority = 2 
    WHERE m.lifecycle_state = 'published' AND priority = 5
""")
print(f"Memory priority 2 (published): {cur.rowcount}")

conn.commit()

# Report
cur.execute("SELECT priority, count(*) FROM preserve.fact GROUP BY 1 ORDER BY 1")
print("\nFact priority distribution:")
for row in cur.fetchall():
    print(f"  priority {row[0]}: {row[1]}")

conn.close()
print("\nBackfill complete")
