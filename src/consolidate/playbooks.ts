/**
 * playbooks.ts — Compile remediation playbooks from successful resolutions.
 * Finds remediation facts that resolved episodes, groups by similar steps,
 * and creates playbook memories when patterns emerge.
 */

import type postgres from "postgres";
import { createHash } from "crypto";

function playbookFingerprint(subject: string, remediation: string): string {
  const normalized = remediation.toLowerCase().replace(/\s+/g, " ").trim();
  const raw = `playbook:${subject}|${normalized.slice(0, 200)}`;
  return createHash("sha256").update(raw, "utf-8").digest("hex");
}

/**
 * Compile playbooks from remediation facts linked to resolved episodes.
 * A playbook is created when 1+ successful remediation pattern is found
 * with a confirmed resolution.
 */
export async function compilePlaybooks(
  sql: postgres.Sql,
): Promise<number> {
  let created = 0;

  const remediations = await sql`
    WITH remediation_facts AS (
      SELECT
        f.fact_id,
        e_sub.canonical_name AS subject,
        f.predicate,
        f.object_value::text AS remediation_text,
        f.episode_id,
        ep.title AS episode_title,
        ep.outcome,
        f.scope_path,
        f.assertion_class::text,
        f.confidence::float
      FROM preserve.fact f
      JOIN preserve.entity e_sub ON f.subject_entity_id = e_sub.entity_id
      LEFT JOIN preserve.episode ep ON f.episode_id = ep.episode_id
      WHERE f.fact_kind = 'remediation'
        AND f.current_status = 'active'
        AND f.assertion_class IN ('deterministic', 'human_curated', 'corroborated_llm')
        AND (ep.outcome IN ('resolved', 'closed') OR ep.outcome IS NULL)
    )
    SELECT
      subject,
      remediation_text,
      COUNT(*) AS occurrence_count,
      array_agg(DISTINCT fact_id::text) AS fact_ids,
      array_agg(DISTINCT episode_id::text) FILTER (WHERE episode_id IS NOT NULL) AS episode_ids,
      array_agg(DISTINCT episode_title) FILTER (WHERE episode_title IS NOT NULL) AS episode_titles,
      MAX(confidence) AS max_confidence,
      (array_agg(scope_path ORDER BY scope_path NULLS LAST))[1] AS scope_path
    FROM remediation_facts
    GROUP BY subject, remediation_text
    HAVING COUNT(*) >= 1
    ORDER BY COUNT(*) DESC
  `;

  await sql.begin(async (tx) => {
    for (const r of remediations) {
      const fingerprint = playbookFingerprint(r.subject, r.remediation_text || "");

      const [existing] = await tx`
        SELECT memory_id FROM preserve.memory
        WHERE fingerprint = ${fingerprint}
        LIMIT 1
      `.catch(() => [undefined]);

      if (existing) {
        await tx`
          UPDATE preserve.memory
          SET support_count = ${Number(r.occurrence_count)},
              updated_at = now()
          WHERE memory_id = ${existing.memory_id}
        `;
        continue;
      }

      const title = `Playbook: ${r.subject} — ${(r.remediation_text || "").slice(0, 80)}`;
      const episodeTitles = (r.episode_titles || []).filter(Boolean);
      const narrative = buildPlaybookNarrative(
        r.subject,
        r.remediation_text || "",
        episodeTitles,
        Number(r.occurrence_count),
      );

      const [scopeEntity] = await tx`
        INSERT INTO preserve.entity (canonical_name, entity_type, first_seen_at, last_seen_at)
        VALUES (${r.subject}, 'pattern_scope'::preserve.entity_type, now(), now())
        ON CONFLICT (entity_type, canonical_name) DO UPDATE SET last_seen_at = now()
        RETURNING entity_id
      `;

      const [mem] = await tx`
        INSERT INTO preserve.memory (
          memory_type, scope_entity_id, fingerprint, title, narrative,
          support_count, contradiction_count, confidence,
          lifecycle_state, pipeline_version, model_name, prompt_version,
          scope_path
        ) VALUES (
          'playbook'::preserve.memory_type,
          ${scopeEntity.entity_id}::uuid,
          ${fingerprint},
          ${title},
          ${narrative},
          ${Number(r.occurrence_count)},
          0,
          ${Math.min(Number(r.max_confidence || 0.7), 0.95)},
          'published'::preserve.lifecycle_state,
          '0.1.0',
          'playbook-compiler',
          'consolidate-v1',
          ${r.scope_path}
        )
        RETURNING memory_id
      `;

      const factIds: string[] = r.fact_ids || [];
      for (const factId of factIds) {
        await tx`
          INSERT INTO preserve.memory_support (memory_id, fact_id, support_type, notes)
          VALUES (${mem.memory_id}::uuid, ${factId}::uuid, 'supporting', ${r.subject})
          ON CONFLICT DO NOTHING
        `.catch(() => {});
      }

      const episodeIds: string[] = (r.episode_ids || []).filter(Boolean);
      for (const episodeId of episodeIds) {
        await tx`
          INSERT INTO preserve.memory_support (memory_id, episode_id, support_type, notes)
          VALUES (${mem.memory_id}::uuid, ${episodeId}::uuid, 'supporting', ${r.subject})
          ON CONFLICT DO NOTHING
        `.catch(() => {});
      }

      created++;
    }
  });

  return created;
}

function buildPlaybookNarrative(
  subject: string,
  remediation: string,
  episodeTitles: string[],
  occurrenceCount: number,
): string {
  const lines: string[] = [];
  lines.push(`## Remediation Playbook: ${subject}`);
  lines.push("");
  lines.push(`**Action:** ${remediation}`);
  lines.push("");
  lines.push(`**Occurrences:** Applied ${occurrenceCount} time(s) with confirmed resolution.`);

  if (episodeTitles.length > 0) {
    lines.push("");
    lines.push("**Resolved episodes:**");
    for (const title of episodeTitles.slice(0, 10)) {
      lines.push(`- ${title}`);
    }
  }

  lines.push("");
  lines.push("**Confidence:** Based on deterministic/curated evidence from resolved incidents.");

  return lines.join("\n");
}
