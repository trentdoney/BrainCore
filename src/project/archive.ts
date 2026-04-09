/**
 * archive.ts — Archive a project, retiring its non-milestone memories.
 */

import { sql } from "../db";

export async function archiveProject(projectName: string, reason: string) {
  // 1. Find project entity
  const [project] = await sql`
    SELECT entity_id FROM preserve.entity
    WHERE entity_type = 'project' AND canonical_name = ${projectName}
  `;
  if (!project) throw new Error(`Project not found: ${projectName}`);

  // 2. Update entity attrs
  await sql`
    UPDATE preserve.entity
    SET attrs = attrs || ${sql.json({
      status: "archived",
      archived_at: new Date().toISOString(),
      archive_reason: reason,
    })}
    WHERE entity_id = ${project.entity_id}
  `;

  // 3. Count affected facts
  const [count] = await sql`
    SELECT count(*) as n FROM preserve.fact
    WHERE project_entity_id = ${project.entity_id}
  `;

  // 4. Retire non-milestone memories for this project
  const retired = await sql`
    UPDATE preserve.memory SET lifecycle_state = 'retired'
    WHERE project_entity_id = ${project.entity_id}
      AND lifecycle_state = 'published'
      AND NOT EXISTS (
        SELECT 1 FROM preserve.memory_support ms
        JOIN preserve.fact f ON f.fact_id = ms.fact_id
        WHERE ms.memory_id = preserve.memory.memory_id
          AND f.is_milestone = TRUE
      )
    RETURNING memory_id
  `;

  console.log(
    `Archived project ${projectName}: ${count.n} facts, ${retired.length} memories retired, reason: ${reason}`,
  );

  return {
    project: projectName,
    entityId: project.entity_id,
    factsCount: Number(count.n),
    memoriesRetired: retired.length,
    reason,
  };
}
