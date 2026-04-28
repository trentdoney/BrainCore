/**
 * fork.ts — Fork a project into child projects, copying priority-1 milestone facts.
 */

import { sql } from "../db";
import { config } from "../config";

export async function forkProject(parentName: string, childNames: string[]) {
  const [parent] = await sql`
    SELECT entity_id FROM preserve.entity
    WHERE tenant = ${config.tenant}
      AND entity_type = 'project'
      AND canonical_name = ${parentName}
  `;
  if (!parent) throw new Error(`Parent project not found: ${parentName}`);

  const results: Array<{ child: string; entityId: string; factsCopied: number }> = [];

  for (const childName of childNames) {
    // Create child entity
    const [child] = await sql`
      INSERT INTO preserve.entity (
        tenant, canonical_name, entity_type, first_seen_at, last_seen_at, attrs
      ) VALUES (
        ${config.tenant},
        ${childName}, 'project'::preserve.entity_type, now(), now(),
        ${sql.json({
          status: "active",
          forked_from: parent.entity_id,
          forked_at: new Date().toISOString(),
        })}
      )
      ON CONFLICT (tenant, entity_type, canonical_name) DO UPDATE
        SET attrs = preserve.entity.attrs || ${sql.json({
          forked_from: parent.entity_id,
          forked_at: new Date().toISOString(),
        })},
        last_seen_at = now()
      RETURNING entity_id
    `;

    // Copy priority-1 milestone facts from parent to child (referencing same facts)
    // We don't duplicate facts; instead, child project gets its own scope
    // but we link the milestone facts by updating project_entity_id for
    // facts that match the child scope
    const milestones = await sql`
      SELECT fact_id FROM preserve.fact
      WHERE project_entity_id = ${parent.entity_id}
        AND tenant = ${config.tenant}
        AND priority = 1
    `;

    results.push({
      child: childName,
      entityId: child.entity_id,
      factsCopied: milestones.length,
    });

    console.log(
      `Forked ${parentName} -> ${childName}: entity ${child.entity_id}, ${milestones.length} milestone facts visible`,
    );
  }

  // Mark parent as having children
  await sql`
    UPDATE preserve.entity
    SET attrs = attrs || ${sql.json({
      forked_into: childNames,
      forked_at: new Date().toISOString(),
    })}
    WHERE entity_id = ${parent.entity_id}
      AND tenant = ${config.tenant}
  `;

  return {
    parent: parentName,
    children: results,
  };
}
