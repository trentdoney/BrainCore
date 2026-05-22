process.env.BRAINCORE_POSTGRES_DSN ??= ["postgresql", "://", "postgres:postgres@localhost:5432/postgres"].join("");

import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyProjectDocReviewDecisions,
  listProjectDocReviews,
  queueProjectDocReview,
  renderProjectDocReviewPacket,
} from "../memory/project-doc-review";

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

describe("project doc review", () => {
  test("lists and renders project doc value-review rows", async () => {
    const { sql, calls } = makeSql(() => [{
      review_id: "review-1",
      status: "pending",
      source_key: "project_doc:example_project:authority-model:abc",
      scope_path: "project:example_project/doc:authority-model",
      original_path: "/ops/README.md",
      fact_count: 3,
      created_at: "2026-05-22",
    }]);

    const rows = await listProjectDocReviews(sql, { status: "pending", limit: 1 });
    const markdown = renderProjectDocReviewPacket(rows);

    expect(rows[0].reviewId).toBe("review-1");
    expect(rows[0].factCount).toBe(3);
    expect(markdown).toContain("Value gate");
    expect(calls[0].query).toContain("a.source_type = 'project_doc'::preserve.source_type");
  });

  test("queues review only for project_doc artifacts", async () => {
    const { sql, calls } = makeSql(() => []);

    await queueProjectDocReview(sql, "00000000-0000-4000-8000-000000000001", "tenant-a");

    expect(calls[0].query).toContain("preserve.review_queue");
    expect(calls[0].query).toContain("'project_doc'::preserve.source_type");
    expect(calls[0].values).toContain("tenant-a");
  });

  test("approved decisions require useful operator context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "braincore-project-doc-review-"));
    const path = join(dir, "decisions.json");
    await writeFile(path, JSON.stringify({ decisions: [{ reviewId: "review-1", decision: "approved", title: "short" }] }));
    const { sql } = makeSql((query) => {
      if (query.includes("FROM preserve.review_queue rq")) return [{
        review_id: "review-1",
        artifact_id: "artifact-1",
        source_key: "project_doc:example_project:authority-model:abc",
        scope_path: "project:example_project/doc:authority-model",
        project_entity_id: null,
        original_path: "/ops/README.md",
      }];
      return [];
    });

    await expect(applyProjectDocReviewDecisions(sql, path)).rejects.toThrow("title");
  });

  test("approved decisions write governed memory and support links", async () => {
    const dir = await mkdtemp(join(tmpdir(), "braincore-project-doc-review-ok-"));
    const path = join(dir, "decisions.json");
    await writeFile(path, JSON.stringify({ decisions: [{
      reviewId: "review-1",
      decision: "approved",
      title: "Example project authority model",
      content: "The task tracker owns task state while local runtime owners govern execution state.",
      materiality: "Prevents agents from treating stale legacy control-plane docs as current.",
      retrievalUseCase: "Inject when an agent opens example_project or asks what controls task and runtime state.",
    }] }));
    const { sql, calls } = makeSql((query) => {
      if (query.includes("FROM preserve.review_queue rq")) return [{
        review_id: "review-1",
        artifact_id: "artifact-1",
        source_key: "project_doc:example_project:authority-model:abc",
        scope_path: "project:example_project/doc:authority-model",
        project_entity_id: null,
        original_path: "/ops/README.md",
      }];
      if (query.includes("JOIN preserve.fact f")) return [{
        fact_id: "fact-1",
        episode_id: "episode-1",
        predicate: "runtime_authority",
        object_value: "The legacy scheduler is retired.",
        confidence: 0.94,
        priority: 2,
        created_at: "2026-05-22",
      }];
      if (query.includes("INSERT INTO preserve.memory")) return [{ memory_id: "memory-1" }];
      return [];
    });

    const result = await applyProjectDocReviewDecisions(sql, path, { actor: "test" });

    expect(result).toEqual({ approved: 1, rejected: 0, memories: ["memory-1"] });
    expect(calls.some((call) => call.query.includes("'human_curated'::preserve.memory_trust_class"))).toBe(true);
    expect(calls.some((call) => call.query.includes("INSERT INTO preserve.memory_support"))).toBe(true);
    expect(calls.some((call) => call.query.includes("status = 'approved'::preserve.review_status"))).toBe(true);
  });
});
