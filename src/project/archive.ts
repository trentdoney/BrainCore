/**
 * archive.ts — Archive a project, retiring memories without priority-1 support.
 */

export type ArchiveSqlLike = {
  (strings: TemplateStringsArray, ...values: unknown[]): any;
  json(value: unknown): unknown;
};

export async function archiveProjectWithDb(
  sql: ArchiveSqlLike,
  tenant: string,
  projectName: string,
  reason: string,
  now: Date,
) {
  // 1. Find project entity
  const [project] = await sql`
    SELECT entity_id FROM preserve.entity
    WHERE tenant = ${tenant}
      AND entity_type = 'project'
      AND canonical_name = ${projectName}
  `;
  if (!project) throw new Error(`Project not found: ${projectName}`);

  // 2. Update entity attrs
  const archivedAt = now.toISOString();
  await sql`
    UPDATE preserve.entity
    SET attrs = attrs || ${sql.json({
      status: "archived",
      archived_at: archivedAt,
      archive_reason: reason,
    })}
    WHERE entity_id = ${project.entity_id}
      AND tenant = ${tenant}
      AND entity_type = 'project'
  `;

  // 3. Count affected facts
  const [count] = await sql`
    SELECT count(*) as n FROM preserve.fact
    WHERE tenant = ${tenant}
      AND project_entity_id = ${project.entity_id}
  `;

  // 4. Retire memories without priority-1 support for this project
  const retired = await sql`
    UPDATE preserve.memory AS m
    SET lifecycle_state = 'retired'
    WHERE m.tenant = ${tenant}
      AND m.project_entity_id = ${project.entity_id}
      AND m.lifecycle_state = 'published'
      AND NOT EXISTS (
        SELECT 1 FROM preserve.memory_support ms
        JOIN preserve.fact f ON f.fact_id = ms.fact_id
        WHERE ms.memory_id = m.memory_id
          AND f.tenant = ${tenant}
          AND f.project_entity_id = ${project.entity_id}
          AND f.priority = 1
      )
    RETURNING m.memory_id
  `;

  return {
    project: projectName,
    entityId: project.entity_id,
    factsCount: Number(count.n),
    memoriesRetired: retired.length,
    reason,
  };
}

export async function archiveProject(projectName: string, reason: string) {
  const { sql } = await import("../db");
  const { config } = await import("../config");

  return archiveProjectWithDb(sql, config.tenant, projectName, reason, new Date());
}
