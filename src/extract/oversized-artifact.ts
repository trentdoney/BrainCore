import type postgres from "postgres";

export interface OversizedIncidentArtifactInput {
  slug: string;
  sourceKey?: string;
  scopePath?: string;
  incidentPath: string;
  fileSha256: string;
  fileSize: number;
  tenant: string;
}

type SqlLike = postgres.Sql | postgres.TransactionSql;

export async function queueOversizedIncidentArtifact(
  sql: SqlLike,
  input: OversizedIncidentArtifactInput,
): Promise<string> {
  const sourceKey = input.sourceKey || input.slug;
  const fallbackScope = input.scopePath || `incident:${input.slug}`;
  const existing = await sql`
    SELECT artifact_id FROM preserve.artifact
    WHERE source_key = ${sourceKey}
      AND tenant = ${input.tenant}
    LIMIT 1
  `.catch(() => [] as any[]);

  let artifactId: string;
  if (existing.length > 0) {
    artifactId = existing[0].artifact_id;
  } else {
    const [newArtifact] = await sql`
      INSERT INTO preserve.artifact (
        source_key, source_type, original_path, sha256, size_bytes,
        scope_path, can_query_raw, can_promote_memory, tenant,
        preservation_state
      ) VALUES (
        ${sourceKey},
        'vault_incident'::preserve.source_type,
        ${input.incidentPath},
        ${input.fileSha256},
        ${input.fileSize},
        ${fallbackScope},
        false, false, ${input.tenant},
        'pending_escalation'::preserve.preservation_state
      )
      RETURNING artifact_id
    `;
    artifactId = newArtifact.artifact_id;
  }

  await sql`
    UPDATE preserve.artifact
    SET preservation_state = 'pending_escalation'::preserve.preservation_state,
        scope_path = COALESCE(scope_path, ${fallbackScope}),
        updated_at = now()
    WHERE artifact_id = ${artifactId}::uuid
      AND tenant = ${input.tenant}
  `;
  await sql`
    INSERT INTO preserve.review_queue (target_type, target_id, reason, status)
    SELECT
      'artifact',
      ${artifactId}::uuid,
      'source_too_large',
      'pending'::preserve.review_status
    WHERE NOT EXISTS (
      SELECT 1
      FROM preserve.review_queue rq
      WHERE rq.target_type = 'artifact'
        AND rq.target_id = ${artifactId}::uuid
        AND rq.reason = 'source_too_large'
        AND rq.status = 'pending'
    )
  `;

  return artifactId;
}
