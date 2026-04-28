/**
 * tagging.ts — Project tag backfill helpers.
 */

export type ProjectTaggingSqlLike = {
  (strings: TemplateStringsArray, ...values: unknown[]): any;
  begin?<T>(fn: (sql: ProjectTaggingSqlLike) => Promise<T>): Promise<T>;
};

export interface MemoryProjectBackfillResult {
  memoriesTagged: number;
  unresolvedMemories: number;
}

export async function backfillMemoryProjectTagsWithDb(
  sql: ProjectTaggingSqlLike,
  tenant: string,
): Promise<MemoryProjectBackfillResult> {
  if (typeof sql.begin === "function") {
    return sql.begin((tx) => backfillMemoryProjectTagsInTransaction(tx, tenant));
  }

  return backfillMemoryProjectTagsInTransaction(sql, tenant);
}

async function backfillMemoryProjectTagsInTransaction(
  sql: ProjectTaggingSqlLike,
  tenant: string,
): Promise<MemoryProjectBackfillResult> {
  await sql`
    UPDATE preserve.memory
    SET project_entity_id = NULL
    WHERE tenant = ${tenant}
  `;

  const memoryRetagged = await sql`
    WITH supported_projects AS (
      SELECT
        m.memory_id,
        cp.project_entity_id
      FROM preserve.memory m
      JOIN preserve.memory_support ms
        ON ms.memory_id = m.memory_id
      LEFT JOIN LATERAL (
        SELECT f.project_entity_id
        FROM preserve.fact f
        JOIN preserve.entity p
          ON p.entity_id = f.project_entity_id
         AND p.tenant = ${tenant}
         AND p.entity_type = 'project'
        WHERE f.fact_id = ms.fact_id
          AND f.tenant = ${tenant}
          AND f.project_entity_id IS NOT NULL
        UNION ALL
        SELECT ep.project_entity_id
        FROM preserve.episode ep
        JOIN preserve.entity p
          ON p.entity_id = ep.project_entity_id
         AND p.tenant = ${tenant}
         AND p.entity_type = 'project'
        WHERE ep.episode_id = ms.episode_id
          AND ep.tenant = ${tenant}
          AND ep.project_entity_id IS NOT NULL
      ) cp ON TRUE
      WHERE m.tenant = ${tenant}
    ),
    candidate_projects AS (
      SELECT
        memory_id,
        min(project_entity_id::text)::uuid AS project_entity_id,
        count(DISTINCT project_entity_id) AS project_count
      FROM supported_projects
      GROUP BY memory_id
    )
    UPDATE preserve.memory m
    SET project_entity_id = cp.project_entity_id
    FROM candidate_projects cp
    WHERE m.memory_id = cp.memory_id
      AND m.tenant = ${tenant}
      AND cp.project_count = 1
    RETURNING m.memory_id
  `;

  const [unresolved] = await sql`
    WITH supported_projects AS (
      SELECT
        m.memory_id,
        cp.project_entity_id
      FROM preserve.memory m
      JOIN preserve.memory_support ms
        ON ms.memory_id = m.memory_id
      LEFT JOIN LATERAL (
        SELECT f.project_entity_id
        FROM preserve.fact f
        JOIN preserve.entity p
          ON p.entity_id = f.project_entity_id
         AND p.tenant = ${tenant}
         AND p.entity_type = 'project'
        WHERE f.fact_id = ms.fact_id
          AND f.tenant = ${tenant}
          AND f.project_entity_id IS NOT NULL
        UNION ALL
        SELECT ep.project_entity_id
        FROM preserve.episode ep
        JOIN preserve.entity p
          ON p.entity_id = ep.project_entity_id
         AND p.tenant = ${tenant}
         AND p.entity_type = 'project'
        WHERE ep.episode_id = ms.episode_id
          AND ep.tenant = ${tenant}
          AND ep.project_entity_id IS NOT NULL
      ) cp ON TRUE
      WHERE m.tenant = ${tenant}
    ),
    candidate_projects AS (
      SELECT memory_id, count(DISTINCT project_entity_id) AS project_count
      FROM supported_projects
      GROUP BY memory_id
    )
    SELECT count(*) AS n
    FROM candidate_projects
    WHERE project_count <> 1
  `;

  return {
    memoriesTagged: memoryRetagged.length,
    unresolvedMemories: Number(unresolved?.n || 0),
  };
}
