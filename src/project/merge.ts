/**
 * merge.ts — Merge one project into another, rescoping all data.
 */

import { sql } from "../db";
import { config } from "../config";

export async function mergeProject(sourceName: string, targetName: string) {
  const [source] = await sql`
    SELECT entity_id FROM preserve.entity
    WHERE tenant = ${config.tenant}
      AND entity_type = 'project'
      AND canonical_name = ${sourceName}
  `;
  const [target] = await sql`
    SELECT entity_id FROM preserve.entity
    WHERE tenant = ${config.tenant}
      AND entity_type = 'project'
      AND canonical_name = ${targetName}
  `;
  if (!source) throw new Error(`Source project not found: ${sourceName}`);
  if (!target) throw new Error(`Target project not found: ${targetName}`);

  const counts: Record<string, number> = {};

  // 1. Rescope all facts/segments/memories/artifacts/episodes
  for (const table of ["artifact", "fact", "segment", "memory", "episode"] as const) {
    const result = await sql`
      UPDATE preserve.${sql(table)}
      SET project_entity_id = ${target.entity_id}
      WHERE project_entity_id = ${source.entity_id}
        AND tenant = ${config.tenant}
      RETURNING 1
    `;
    counts[table] = result.length;
  }

  // 2. Regenerate scope_path
  await sql`
    UPDATE preserve.artifact
    SET scope_path = regexp_replace(scope_path, ${`project:${sourceName}`}, ${`project:${targetName}`})
    WHERE project_entity_id = ${target.entity_id}
      AND tenant = ${config.tenant}
      AND scope_path LIKE ${`%project:${sourceName}%`}
  `;
  await sql`
    UPDATE preserve.fact
    SET scope_path = regexp_replace(scope_path, ${`project:${sourceName}`}, ${`project:${targetName}`})
    WHERE project_entity_id = ${target.entity_id}
      AND tenant = ${config.tenant}
      AND scope_path LIKE ${`%project:${sourceName}%`}
  `;

  // 3. Mark source as merged
  await sql`
    UPDATE preserve.entity
    SET attrs = attrs || ${sql.json({
      status: "merged",
      merged_into: target.entity_id,
      merged_at: new Date().toISOString(),
    })}
    WHERE entity_id = ${source.entity_id}
      AND tenant = ${config.tenant}
  `;

  // 4. Add alias
  await sql`
    UPDATE preserve.entity
    SET aliases = COALESCE(aliases, '[]'::jsonb) || ${sql.json([sourceName])}
    WHERE entity_id = ${target.entity_id}
      AND tenant = ${config.tenant}
  `;

  console.log(`Merged ${sourceName} -> ${targetName}:`, counts);

  return {
    source: sourceName,
    target: targetName,
    counts,
  };
}
