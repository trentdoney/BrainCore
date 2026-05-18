import { describe, expect, test } from "bun:test";
import { renderBrainCoreSnapshot, resolveSnapshotDomains } from "../memory/snapshot";
import type { ContextRecallResult } from "../memory/governance";

describe("BrainCore snapshot", () => {
  test("infers workspace project domain from cwd", () => {
    const domains = resolveSnapshotDomains(
      "/repo/10_projects/Memory",
      "/repo/repo",
      "braincore memory runtime",
    );
    expect(domains).toContain("memory");
    expect(domains).toContain("braincore");
  });

  test("renders no-results gate without pretending imports are prompt eligible", () => {
    const recall: ContextRecallResult = {
      trigger: "braincore_snapshot",
      mode: "shadow",
      injected: false,
      results: [],
      promptPackage: [],
      omitted: [],
      totalTokens: 0,
    };

    const markdown = renderBrainCoreSnapshot(
      { cwd: "/repo/10_projects/Memory", gitRoot: "/repo/repo", mode: "shadow" },
      ["memory"],
      recall,
    );

    expect(markdown).toContain("# BrainCore Memory Snapshot");
    expect(markdown).toContain("Candidate domains: memory");
    expect(markdown).toContain("No Prompt-Eligible BrainCore Memories");
    expect(markdown).toContain("remain gated until explicitly approved");
  });

  test("enforces snapshot token budget on rendered output", async () => {
    const sql = (() => Promise.resolve([])) as any;
    sql.json = (value: unknown) => value;
    const result = await (await import("../memory/snapshot")).buildBrainCoreSnapshot(sql, {
      cwd: "/repo/10_projects/Memory",
      gitRoot: "/repo",
      prompt: "memory ".repeat(200),
      mode: "shadow",
      maxTokens: 40,
    });

    expect(result.truncated).toBe(true);
    expect(result.tokenEstimate).toBeLessThanOrEqual(40);
    expect(result.markdown).toContain("Budget Notice");
  });
});
