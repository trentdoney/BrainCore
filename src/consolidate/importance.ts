/**
 * importance.ts — Compute importance scores for facts.
 * Scores based on: priority-1 milestone status, assertion class, episode severity,
 * and recency. Capped at 100.
 */

import { sql } from "../db";

export async function computeImportanceScores(): Promise<number> {
  const result = await sql`
    UPDATE preserve.fact f SET importance_score = LEAST(100,
      CASE WHEN f.priority = 1 THEN 50 ELSE 0 END
      + CASE WHEN f.assertion_class = 'deterministic' THEN 10
             WHEN f.assertion_class = 'corroborated_llm' THEN 15
             ELSE 0 END
      + CASE WHEN ep.severity IN ('critical','P1') THEN 20
             WHEN ep.severity IN ('major','P2') THEN 10
             ELSE 0 END
      + GREATEST(0, 20 - EXTRACT(DAY FROM now() - f.created_at) * 0.1)
    )
    FROM preserve.episode ep
    WHERE f.episode_id = ep.episode_id
    RETURNING f.fact_id
  `;
  return result.length;
}
