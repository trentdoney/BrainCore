#!/usr/bin/env python3
"""Retroactively tag all artifacts/facts/segments/episodes/memories with project_entity_id."""
import os
import re
import psycopg

DSN = os.environ.get("BRAINCORE_POSTGRES_DSN")
if not DSN:
    raise SystemExit("BRAINCORE_POSTGRES_DSN is not set")
TENANT = os.environ.get("BRAINCORE_TENANT", "default")

conn = psycopg.connect(DSN)
cur = conn.cursor()

# Get project service map
cur.execute("""
    SELECT e.entity_id, e.canonical_name, array_agg(psm.service_name) as services
    FROM preserve.project_service_map psm
    JOIN preserve.entity e ON e.entity_id = psm.project_entity_id
    WHERE e.tenant = %s
    GROUP BY e.entity_id, e.canonical_name
""", (TENANT,))
projects = cur.fetchall()
print(f"Loaded {len(projects)} projects for tenant={TENANT}")

# For each artifact, find matching project via its services
cur.execute("""
    SELECT a.artifact_id, a.source_key, a.original_path, a.scope_path
    FROM preserve.artifact a
    WHERE a.tenant = %s
      AND a.project_entity_id IS NULL
""", (TENANT,))
artifacts = cur.fetchall()
print(f"Found {len(artifacts)} untagged artifacts")

tagged = 0
for art_id, source_key, original_path, scope_path in artifacts:
    # Get services from this artifact's entities
    cur.execute("""
        SELECT DISTINCT e.canonical_name
        FROM preserve.fact f
        JOIN preserve.entity e ON e.entity_id = f.subject_entity_id
        JOIN preserve.extraction_run er ON er.run_id = f.created_run_id
        WHERE er.artifact_id = %s
          AND f.tenant = %s
          AND e.tenant = %s
          AND e.entity_type = 'service'
    """, (str(art_id), TENANT, TENANT))
    artifact_services = [r[0].lower() for r in cur.fetchall()]

    # Also check path
    path_project = None
    if '10_projects/' in (original_path or ''):
        m = re.search(r'10_projects/([^/]+)', original_path)
        if m:
            path_project = m.group(1).lower().replace('_', '-')

    matched_project = None
    for proj_id, proj_name, proj_services in projects:
        proj_services_lower = [s.lower() for s in proj_services]
        if any(s in proj_services_lower for s in artifact_services):
            matched_project = (proj_id, proj_name)
            break
        if path_project and proj_name.lower() == path_project:
            matched_project = (proj_id, proj_name)
            break

    if matched_project:
        proj_id, proj_name = matched_project
        new_scope = f"project:{proj_name}/{scope_path}" if scope_path else f"project:{proj_name}"

        # Update artifact
        cur.execute(
            "UPDATE preserve.artifact SET project_entity_id = %s, scope_path = %s WHERE artifact_id = %s AND tenant = %s",
            (str(proj_id), new_scope, str(art_id), TENANT),
        )
        # Update all facts for this artifact
        cur.execute("""
            UPDATE preserve.fact SET project_entity_id = %s, scope_path = %s || '/' || COALESCE(scope_path, '')
            FROM preserve.extraction_run er
            WHERE preserve.fact.created_run_id = er.run_id AND er.artifact_id = %s AND preserve.fact.project_entity_id IS NULL
              AND preserve.fact.tenant = %s
        """, (str(proj_id), f"project:{proj_name}", str(art_id), TENANT))
        # Update segments
        cur.execute(
            "UPDATE preserve.segment SET project_entity_id = %s WHERE artifact_id = %s AND project_entity_id IS NULL AND tenant = %s",
            (str(proj_id), str(art_id), TENANT),
        )
        # Update episodes
        cur.execute(
            "UPDATE preserve.episode SET project_entity_id = %s WHERE primary_artifact_id = %s AND project_entity_id IS NULL AND tenant = %s",
            (str(proj_id), str(art_id), TENANT),
        )

        tagged += 1

cur.execute("UPDATE preserve.memory SET project_entity_id = NULL WHERE tenant = %s", (TENANT,))
cur.execute("""
    WITH candidate_projects AS (
        SELECT
            ms.memory_id,
            min(cp.project_entity_id) AS project_entity_id,
            count(DISTINCT cp.project_entity_id) AS project_count
        FROM preserve.memory_support ms
        JOIN preserve.memory m ON m.memory_id = ms.memory_id AND m.tenant = %s
        JOIN LATERAL (
            SELECT f.project_entity_id
            FROM preserve.fact f
            WHERE f.fact_id = ms.fact_id
              AND f.tenant = %s
              AND f.project_entity_id IS NOT NULL
            UNION ALL
            SELECT ep.project_entity_id
            FROM preserve.episode ep
            WHERE ep.episode_id = ms.episode_id
              AND ep.tenant = %s
              AND ep.project_entity_id IS NOT NULL
        ) cp ON TRUE
        GROUP BY ms.memory_id
    )
    UPDATE preserve.memory m
    SET project_entity_id = cp.project_entity_id
    FROM candidate_projects cp
    WHERE m.memory_id = cp.memory_id
      AND m.tenant = %s
      AND cp.project_count = 1
""", (TENANT, TENANT, TENANT, TENANT))

conn.commit()
print(f"Tagged {tagged}/{len(artifacts)} artifacts with projects")

# Summary
cur.execute("""
    SELECT e.canonical_name, count(a.artifact_id)
    FROM preserve.artifact a
    JOIN preserve.entity e ON e.entity_id = a.project_entity_id
    WHERE a.tenant = %s
    GROUP BY e.canonical_name ORDER BY count DESC
""", (TENANT,))
for name, count in cur.fetchall():
    print(f"  {name}: {count} artifacts")

# Untagged
cur.execute("SELECT count(*) FROM preserve.artifact WHERE tenant = %s AND project_entity_id IS NULL", (TENANT,))
print(f"  (untagged): {cur.fetchone()[0]} artifacts")

conn.close()
