import type postgres from "postgres";

export function lifecycleProcedureVisibleSql(sql: postgres.Sql, enabled: boolean) {
  return enabled
    ? sql`
        AND NOT EXISTS (
          SELECT 1
          FROM preserve.lifecycle_target_intelligence lti
          WHERE lti.tenant = p.tenant
            AND lti.target_kind = 'procedure'
            AND lti.target_id = p.procedure_id
            AND lti.lifecycle_status IN ('suppressed', 'retired')
        )
      `
    : sql``;
}

export function isMissingLifecycleIntelligenceTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { code?: unknown; message?: unknown };
  return maybe.code === "42P01"
    && typeof maybe.message === "string"
    && maybe.message.includes("lifecycle_target_intelligence");
}
