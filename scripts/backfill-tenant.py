#!/usr/bin/env python3
"""Retroactively set tenant on all existing data.

Reads BRAINCORE_TENANT env var (defaults to 'default').
"""
import os
import psycopg

DSN = os.environ["BRAINCORE_POSTGRES_DSN"]
TENANT = os.environ.get("BRAINCORE_TENANT", "default")

conn = psycopg.connect(DSN)
cur = conn.cursor()

tables = ["artifact", "fact", "segment", "entity", "episode", "memory"]
for table in tables:
    try:
        cur.execute(
            f"UPDATE preserve.{table} SET tenant = %s WHERE tenant = 'default'",
            (TENANT,),
        )
        print(f"{table}: {cur.rowcount} rows updated")
        conn.commit()
    except Exception as e:
        conn.rollback()
        print(f"{table}: FAILED — {e}")
        continue

# Verify
print("\n--- Verification ---")
for table in tables:
    try:
        cur.execute(f"SELECT tenant, count(*) FROM preserve.{table} GROUP BY 1 ORDER BY 1")
        rows = cur.fetchall()
        print(f"{table}: {rows}")
    except Exception as e:
        print(f"{table}: VERIFY FAILED — {e}")
        conn.rollback()

conn.close()
