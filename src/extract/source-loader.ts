import type postgres from "postgres";
import { createHash } from "crypto";
import { config } from "../config";
import type { SourceExtraction } from "./source-export";

export async function ensureSourceArtifact(
  sql: postgres.Sql,
  item: SourceExtraction,
  tenant: string = config.tenant,
): Promise<{ artifactId: string; created: boolean }> {
  const [existing] = await sql`
    SELECT artifact_id
    FROM preserve.artifact
    WHERE source_key = ${item.sourceKey}
      AND tenant = ${tenant}
    LIMIT 1
  `;

  if (existing) {
    return { artifactId: existing.artifact_id, created: false };
  }

  const sha256 = createHash("sha256").update(item.sourceContent, "utf-8").digest("hex");
  const [created] = await sql`
    INSERT INTO preserve.artifact (
      source_key, source_type, original_path, sha256, size_bytes,
      scope_path, can_query_raw, can_promote_memory, tenant,
      preservation_state
    ) VALUES (
      ${item.sourceKey},
      ${item.sourceType}::preserve.source_type,
      ${item.originalPath},
      ${sha256},
      ${Buffer.byteLength(item.sourceContent, "utf-8")},
      ${item.result.scope_path},
      false, false, ${tenant},
      'discovered'::preserve.preservation_state
    )
    RETURNING artifact_id
  `;

  return { artifactId: created.artifact_id, created: true };
}
