#!/usr/bin/env python3
"""Retroactively tag all artifacts/facts/segments/episodes/memories with project_entity_id."""
import re
import psycopg

import os
DSN = os.environ.get("BRAINCORE_POSTGRES_DSN", "postgresql://braincore:braincore@localhost:5432/braincore")

conn = psycopg.connect(DSN)
cur = conn.cursor()

# Get project service map
cur.execute("""
    SELECT e.entity_id, e.canonical_name, array_agg(psm.service_name) as services
    FROM preserve.project_service_map psm
    JOIN preserve.entity e ON e.entity_id = psm.project_entity_id
    GROUP BY e.entity_id, e.canonical_name
""")
projects = cur.fetchall()
print(f"Loaded {len(projects)} projects")

# For each artifact, find matching project via its services
cur.execute("""
    SELECT a.artifact_id, a.source_key, a.original_path, a.scope_path
    FROM preserve.artifact a
    WHERE a.project_entity_id IS NULL
""")
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
        WHERE er.artifact_id = %s AND e.entity_type = 'service'
    """, (str(art_id),))
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
        cur.execute("UPDATE preserve.artifact SET project_entity_id = %s, scope_path = %s WHERE artifact_id = %s", (str(proj_id), new_scope, str(art_id)))
        # Update all facts for this artifact
        cur.execute("""
            UPDATE preserve.fact SET project_entity_id = %s, scope_path = %s || '/' || COALESCE(scope_path, '')
            FROM preserve.extraction_run er
            WHERE preserve.fact.created_run_id = er.run_id AND er.artifact_id = %s AND preserve.fact.project_entity_id IS NULL
        """, (str(proj_id), f"project:{proj_name}", str(art_id)))
        # Update segments
        cur.execute("UPDATE preserve.segment SET project_entity_id = %s WHERE artifact_id = %s AND project_entity_id IS NULL", (str(proj_id), str(art_id)))
        # Update episodes
        cur.execute("UPDATE preserve.episode SET project_entity_id = %s WHERE primary_artifact_id = %s AND project_entity_id IS NULL", (str(proj_id), str(art_id)))
        
        tagged += 1

conn.commit()
print(f"Tagged {tagged}/{len(artifacts)} artifacts with projects")

# Summary
cur.execute("""
    SELECT e.canonical_name, count(a.artifact_id) 
    FROM preserve.artifact a
    JOIN preserve.entity e ON e.entity_id = a.project_entity_id
    GROUP BY e.canonical_name ORDER BY count DESC
""")
for name, count in cur.fetchall():
    print(f"  {name}: {count} artifacts")

# Untagged
cur.execute("SELECT count(*) FROM preserve.artifact WHERE project_entity_id IS NULL")
print(f"  (untagged): {cur.fetchone()[0]} artifacts")

conn.close()
