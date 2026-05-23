process.env.BRAINCORE_POSTGRES_DSN ??= ["postgresql", "://", "postgres:postgres@localhost:5432/postgres"].join("");

import { describe, expect, test } from "bun:test";
import {
  listAssistantMemoryReviews,
  assistantMemoryReviewStats,
  demoteAssistantMemoryPromotion,
  getAssistantMemoryReview,
  promoteAssistantMemoryReview,
  rejectAssistantMemoryReview,
  renderAssistantReviewQueueMarkdown,
  queueAssistantMemoryReview,
} from "../memory/assistant-review";

function makeSql(resolver: (query: string, values: unknown[]) => unknown[] | Promise<unknown[]>) {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    calls.push({ query, values });
    return Promise.resolve(resolver(query, values));
  }) as any;
  sql.json = (value: unknown) => value;
  sql.begin = async (callback: (tx: any) => unknown) => callback(sql);
  return { sql, calls };
}

describe("assistant memory review", () => {
  test("lists tenant-bound assistant memory import review rows", async () => {
    const { sql, calls } = makeSql(() => [{
      review_id: "review-1",
      status: "pending",
      reason: "assistant_memory_import_review",
      source_type: "vestige_memory",
      source_key: "vestige:1",
      scope_path: "project:memory",
      original_path: "memory.jsonl",
      fact_count: 3,
      created_at: "2026-05-18",
    }]);

    const rows = await listAssistantMemoryReviews(sql, { status: "pending", limit: 1 });

    expect(rows[0].reviewId).toBe("review-1");
    expect(rows[0].factCount).toBe(3);
    expect(calls[0].query).toContain("preserve.review_queue");
    expect(calls[0].query).toContain("JOIN preserve.artifact");
    expect(calls[0].values).toContain("assistant_memory_import_review");
  });

  test("queues assistant memory imports for review only for assistant source artifacts", async () => {
    const { sql, calls } = makeSql(() => []);

    await queueAssistantMemoryReview(sql, "00000000-0000-4000-8000-000000000001", "tenant-a");

    expect(calls[0].query).toContain("preserve.review_queue");
    expect(calls[0].values).toContain("assistant_memory_import_review");
    expect(calls[0].query).toContain("a.source_type = ANY");
    expect(calls[0].values).toContain("tenant-a");
  });

  test("rejects only assistant memory import artifacts for the active tenant", async () => {
    const { sql, calls } = makeSql(() => [{ review_id: "review-1" }]);

    const updated = await rejectAssistantMemoryReview(sql, "review-1", { notes: "not useful" });

    expect(updated).toBe(true);
    expect(calls[0].query).toContain("UPDATE preserve.review_queue");
    expect(calls[0].query).toContain("FROM preserve.artifact");
    expect(calls[0].query).toContain("a.tenant");
    expect(calls[0].values).toContain("not useful");
  });

  test("promotion writes governed prompt memory, support links, review approval, and artifact eligibility", async () => {
    const { sql, calls } = makeSql((query) => {
      if (query.includes("FROM preserve.review_queue rq") && query.includes("FOR UPDATE")) {
        return [{
          review_id: "review-1",
          artifact_id: "artifact-1",
          source_type: "pai_auto_memory",
          source_key: "pai:1",
          scope_path: "project:memory",
          project_entity_id: "project-1",
          original_path: "auto.md",
        }];
      }
      if (query.includes("JOIN preserve.fact f")) {
        return [{
          fact_id: "fact-1",
          episode_id: "episode-1",
          predicate: "pai_auto_memory_content",
          object_value: { content: "Codex must use BrainCore native snapshots." },
          confidence: 0.91,
          priority: 1,
        }];
      }
      if (query.includes("INSERT INTO preserve.memory")) return [{ memory_id: "memory-1" }];
      return [];
    });

    const result = await promoteAssistantMemoryReview(sql, "review-1", { notes: "approved", scopePath: "project:braincore" });

    expect(result.memoryId).toBe("memory-1");
    expect(result.scopePath).toBe("project:braincore");
    expect(result.trustClass).toBe("human_curated");
    expect(result.idempotent).toBe(false);
    expect(calls.some((call) => call.query.includes("DELETE FROM preserve.memory_support"))).toBe(true);
    expect(calls.some((call) => call.query.includes("INSERT INTO preserve.memory_support"))).toBe(true);
    expect(calls.some((call) => call.query.includes("status = 'approved'::preserve.review_status"))).toBe(true);
    expect(calls.some((call) => call.query.includes("can_promote_memory = true"))).toBe(true);
    expect(calls.some((call) => call.values.includes("project:braincore"))).toBe(true);
  });

  test("promotion reports repeat approvals as idempotent", async () => {
    const { sql } = makeSql((query) => {
      if (query.includes("FROM preserve.review_queue rq") && query.includes("FOR UPDATE")) {
        return [{
          review_id: "review-1",
          review_status: "approved",
          artifact_id: "artifact-1",
          source_type: "vestige_memory",
          source_key: "vestige:1",
          scope_path: "project:memory",
          project_entity_id: "project-1",
          original_path: "memory.jsonl",
        }];
      }
      if (query.includes("JOIN preserve.fact f")) {
        return [{ fact_id: "fact-1", episode_id: "episode-1", predicate: "vestige_memory_content", object_value: "Memory text", confidence: 0.8 }];
      }
      if (query.includes("INSERT INTO preserve.memory")) return [{ memory_id: "memory-1" }];
      return [];
    });

    const result = await promoteAssistantMemoryReview(sql, "review-1");

    expect(result.idempotent).toBe(true);
  });

  test("loads detailed review facts for operator preview", async () => {
    const { sql } = makeSql((query) => {
      if (query.includes("GROUP BY rq.review_id")) return [{
        review_id: "review-1", status: "pending", reason: "assistant_memory_import_review", artifact_id: "artifact-1", source_type: "pai_auto_memory", source_key: "pai:1", fact_count: 1,
      }];
      if (query.includes("JOIN preserve.fact f")) return [{ fact_id: "fact-1", predicate: "pai_auto_memory_content", object_value: { content: "Preview this memory" }, confidence: 0.9 }];
      return [];
    });

    const detail = await getAssistantMemoryReview(sql, "review-1");

    expect(detail?.facts[0].value).toBe("Preview this memory");
  });

  test("summarizes review queue stats and renders export markdown", async () => {
    const { sql } = makeSql(() => [
      { status: "pending", source_type: "pai_auto_memory", count: 2 },
      { status: "approved", source_type: "vestige_memory", count: 1 },
    ]);

    const stats = await assistantMemoryReviewStats(sql);
    const markdown = renderAssistantReviewQueueMarkdown([{ reviewId: "r1", status: "pending", reason: "assistant_memory_import_review", sourceType: "pai_auto_memory", sourceKey: "pai:1", factCount: 2 }]);

    expect(stats.total).toBe(3);
    expect(stats.byStatus.pending).toBe(2);
    expect(markdown).toContain("# BrainCore Assistant Memory Review Queue");
    expect(markdown).toContain("pai:1");
  });

  test("demotion suppresses prompt memory and resets review for re-review", async () => {
    const { sql, calls } = makeSql((query) => {
      if (query.includes("FROM preserve.memory") && query.includes("FOR UPDATE")) {
        return [{
          memory_id: "memory-1",
          governance_meta: { reviewId: "11111111-1111-4111-8111-111111111111", sourceKey: "pai:1" },
          governance_status: "validated",
          source_class: "imported_knowledge",
          trust_class: "human_curated",
        }];
      }
      if (query.includes("UPDATE preserve.review_queue")) return [{ artifact_id: "artifact-1" }];
      return [];
    });

    const result = await demoteAssistantMemoryPromotion(sql, "memory-1", { notes: "bad memory" });

    expect(result.demoted).toBe(true);
    expect(result.resetReview).toBe(true);
    expect(result.reviewId).toBe("11111111-1111-4111-8111-111111111111");
    expect(calls.some((call) => call.query.includes("governance_status = 'suppressed'"))).toBe(true);
    expect(calls.some((call) => call.query.includes("status = 'pending'::preserve.review_status"))).toBe(true);
    expect(calls.some((call) => call.query.includes("can_promote_memory = false"))).toBe(true);
  });

  test("demotion recovers review through support links when metadata was redacted", async () => {
    const { sql, calls } = makeSql((query) => {
      if (query.includes("FROM preserve.memory") && query.includes("FOR UPDATE")) {
        return [{
          memory_id: "memory-1",
          governance_meta: { reviewId: "[REDACTED_TOKEN]", sourceKey: "pai_auto_memory:[REDACTED_TOKEN]" },
          governance_status: "validated",
          source_class: "imported_knowledge",
          trust_class: "human_curated",
        }];
      }
      if (query.includes("FROM preserve.memory_support ms")) {
        return [{ review_id: "22222222-2222-4222-8222-222222222222", source_key: "pai_auto_memory:feedback_codex_review_before_approve" }];
      }
      if (query.includes("UPDATE preserve.review_queue")) return [{ artifact_id: "artifact-1" }];
      return [];
    });

    const result = await demoteAssistantMemoryPromotion(sql, "memory-1", { notes: "rollback drill" });

    expect(result.resetReview).toBe(true);
    expect(result.reviewId).toBe("22222222-2222-4222-8222-222222222222");
    expect(result.sourceKey).toBe("pai_auto_memory:feedback_codex_review_before_approve");
    expect(calls.some((call) => call.query.includes("FROM preserve.memory_support ms"))).toBe(true);
  });

});
