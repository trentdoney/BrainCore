/**
 * updater.ts — Update preserve.memory from pattern candidates.
 * Handles ADD, UPDATE, and RETIRE lifecycle operations with a
 * 7-day stability window to prevent premature retirement.
 * C5: Skip retirement if any supporting fact has priority = 1
 * E2: Staleness detection for memories unsupported for 6+ months
 */

import type postgres from "postgres";
import type { PatternCandidate } from "./patterns";
import { config } from "../config";

export interface UpdateResult {
  added: number;
  updated: number;
  retired: number;
}

/**
 * Reconcile pattern candidates against existing memories.
 * - ADD: new fingerprint -> insert memory + memory_support links
 * - UPDATE: existing fingerprint -> bump support_count, refresh narrative
 * - RETIRE: contradiction_count > support_count AND older than 7 days
 *           BUT skip if any supporting fact is a milestone
 */
export async function updateMemories(
  candidates: PatternCandidate[],
  sql: postgres.Sql,
): Promise<UpdateResult> {
  let added = 0;
  let updated = 0;
  let retired = 0;

  await sql.begin(async (tx) => {
    for (const candidate of candidates) {
      const [existing] = await tx`
        SELECT memory_id, support_count, contradiction_count, created_at
        FROM preserve.memory
        WHERE fingerprint = ${candidate.fingerprint}
          AND tenant = ${config.tenant}
        LIMIT 1
      `.catch(() => [undefined]);

      if (!existing) {
        // ADD: new pattern
        const title = `${candidate.subject} ${candidate.predicate} (${candidate.factKind})`;
        const narrative = buildNarrative(candidate);
        const lifecycleState = candidate.supportCount >= 2 ? "published" : "draft";

        const [scopeEntity] = await tx`
          INSERT INTO preserve.entity (tenant, canonical_name, entity_type, first_seen_at, last_seen_at)
          VALUES (${config.tenant}, ${candidate.subject}, 'pattern_scope'::preserve.entity_type, now(), now())
          ON CONFLICT (tenant, entity_type, canonical_name) DO UPDATE SET last_seen_at = now()
          RETURNING entity_id
        `;

        const [mem] = await tx`
          INSERT INTO preserve.memory (
            memory_type, scope_entity_id, fingerprint, title, narrative,
            support_count, contradiction_count, confidence,
            lifecycle_state, pipeline_version, model_name, prompt_version,
            scope_path, last_supported_at, tenant
          ) VALUES (
            'pattern'::preserve.memory_type,
            ${scopeEntity.entity_id}::uuid,
            ${candidate.fingerprint},
            ${title},
            ${narrative},
            ${candidate.supportCount},
            0,
            ${Math.min(0.5 + candidate.supportCount * 0.1, 0.95)},
            ${lifecycleState}::preserve.lifecycle_state,
            '0.1.0',
            'pattern-compiler',
            'consolidate-v1',
            ${candidate.scopePath},
            now(),
            ${config.tenant}
          )
          RETURNING memory_id
        `;

        for (const factId of candidate.factIds) {
          await tx`
            INSERT INTO preserve.memory_support (memory_id, fact_id, support_type, notes)
            VALUES (${mem.memory_id}::uuid, ${factId}::uuid, 'supporting', ${candidate.predicate})
            ON CONFLICT DO NOTHING
          `.catch(() => {});
        }
        for (const episodeId of candidate.episodeIds) {
          await tx`
            INSERT INTO preserve.memory_support (memory_id, episode_id, support_type, notes)
            VALUES (${mem.memory_id}::uuid, ${episodeId}::uuid, 'supporting', ${candidate.subject})
            ON CONFLICT DO NOTHING
          `.catch(() => {});
        }

        added++;
      } else {
        // UPDATE: existing pattern
        const newSupportCount = Math.max(existing.support_count, candidate.supportCount);
        const narrative = buildNarrative(candidate);
        const lifecycleState = newSupportCount >= 2 ? "published" : "draft";

        await tx`
          UPDATE preserve.memory
          SET support_count = ${newSupportCount},
              narrative = ${narrative},
              confidence = ${Math.min(0.5 + newSupportCount * 0.1, 0.95)},
              lifecycle_state = ${lifecycleState}::preserve.lifecycle_state,
              updated_at = now(),
              last_supported_at = now()
          WHERE memory_id = ${existing.memory_id}
            AND tenant = ${config.tenant}
        `;

        for (const factId of candidate.factIds) {
          await tx`
            INSERT INTO preserve.memory_support (memory_id, fact_id, support_type, notes)
            VALUES (${existing.memory_id}::uuid, ${factId}::uuid, 'supporting', ${candidate.predicate})
            ON CONFLICT DO NOTHING
          `.catch(() => {});
        }
        for (const episodeId of candidate.episodeIds) {
          await tx`
            INSERT INTO preserve.memory_support (memory_id, episode_id, support_type, notes)
            VALUES (${existing.memory_id}::uuid, ${episodeId}::uuid, 'supporting', ${candidate.subject})
            ON CONFLICT DO NOTHING
          `.catch(() => {});
        }

        updated++;
      }
    }

    // RETIRE: memories where contradiction_count > support_count (7-day stability)
    // C5: Skip retirement if any supporting fact has priority = 1
    const retireResult = await tx`
      UPDATE preserve.memory
      SET lifecycle_state = 'retired'::preserve.lifecycle_state,
          updated_at = now()
      WHERE lifecycle_state != 'retired'
        AND tenant = ${config.tenant}
        AND contradiction_count > support_count
        AND created_at < now() - interval '7 days'
        AND NOT EXISTS (
          SELECT 1 FROM preserve.memory_support ms
          JOIN preserve.fact f ON f.fact_id = ms.fact_id
          WHERE ms.memory_id = preserve.memory.memory_id
            AND f.priority = 1
        )
      RETURNING memory_id
    `;
    retired = retireResult.length;
  });

  return { added, updated, retired };
}

/**
 * E2: Detect stale memories — published memories with no fresh support
 * for 6+ months and no milestone backing. Demotes them to draft.
 */
export async function detectStale(sql: postgres.Sql): Promise<number> {
  const stale = await sql`
    UPDATE preserve.memory SET lifecycle_state = 'draft'
    WHERE lifecycle_state = 'published'
    AND tenant = ${config.tenant}
    AND last_supported_at < now() - interval '6 months'
    AND NOT EXISTS (
      SELECT 1 FROM preserve.memory_support ms
      JOIN preserve.fact f ON f.fact_id = ms.fact_id
      WHERE ms.memory_id = preserve.memory.memory_id AND f.priority = 1
    )
    RETURNING memory_id
  `;
  return stale.length;
}

function buildNarrative(candidate: PatternCandidate): string {
  const lines: string[] = [];
  lines.push(`Pattern: ${candidate.subject} exhibits "${candidate.predicate}" behavior.`);
  lines.push(`Kind: ${candidate.factKind}`);
  lines.push(`Support: ${candidate.supportCount} independent episodes confirm this pattern.`);

  if (candidate.representativeValue) {
    const display = candidate.representativeValue.length > 200
      ? candidate.representativeValue.slice(0, 200) + "..."
      : candidate.representativeValue;
    lines.push(`Representative value: ${display}`);
  }

  lines.push(`Episodes: ${candidate.episodeIds.length} corroborating episodes.`);
  lines.push(`Facts: ${candidate.factIds.length} supporting facts.`);

  return lines.join("\n");
}
