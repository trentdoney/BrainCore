import { describe, expect, test } from "bun:test";
import { runBrainCoreShadowEval } from "../memory/shadow-eval";

process.env.BRAINCORE_POSTGRES_DSN ??= ["postgresql", "://", "postgres:postgres@localhost:5432/postgres"].join("");

describe("BrainCore shadow eval", () => {
  test("computes pass/fail metrics from snapshot output", async () => {
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("SELECT") && query.includes("m.memory_id::text")) {
        return Promise.resolve([{
          memory_id: "33333333-3333-3333-3333-333333333333", memory_type: "heuristic", title: "BrainCore recall", narrative: "BrainCore native memory snapshot works.", confidence: 0.9, scope_path: "project:memory", priority: 1, namespace: "semantic", governance_status: "validated", source_class: "imported_knowledge", trust_class: "human_curated", quality_score: 0.9, strength: 0.8, token_count: 8, text_rank: 1,
        }]);
      }
      return Promise.resolve([]);
    }) as any;
    sql.json = (value: unknown) => value;

    const result = await runBrainCoreShadowEval(sql, [{
      name: "memory", cwd: "/repo/10_projects/Memory", gitRoot: "/repo", prompt: "braincore memory", expectedTerms: ["BrainCore native"], forbiddenTerms: ["forbidden"], maxTokens: 500,
    }]);

    expect(result.total).toBe(1);
    expect(result.passed).toBe(true);
    expect(result.usefulRate).toBe(1);
  });
});
