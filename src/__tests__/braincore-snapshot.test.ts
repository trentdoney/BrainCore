import { describe, expect, test } from "bun:test";
import { renderBrainCoreSnapshot, resolveSnapshotBudget, resolveSnapshotDomains } from "../memory/snapshot";
import type { ContextRecallResult } from "../memory/governance";

describe("BrainCore snapshot", () => {
  test("infers workspace project domain from cwd", () => {
    const domains = resolveSnapshotDomains(
      "/workspace/memory",
      undefined,
      "braincore memory runtime",
    );
    expect(domains).toContain("memory");
    expect(domains).not.toContain("braincore");
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
      { cwd: "/workspace/memory", gitRoot: "/workspace/braincore-demo", mode: "shadow" },
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
      cwd: "/workspace/memory",
      gitRoot: "/workspace/memory",
      prompt: "memory ".repeat(200),
      mode: "shadow",
      maxTokens: 40,
    });

    expect(result.truncated).toBe(true);
    expect(result.tokenEstimate).toBeLessThanOrEqual(40);
    expect(result.markdown).toContain("Budget Notice");
  });

  test("does not treat prompt words as candidate domains", () => {
    const domains = resolveSnapshotDomains(
      "/workspace/memory",
      "/workspace/project-root",
      "For verification only inspect Codex shared memory snapshot",
    );
    expect(domains).toEqual(["project-root"]);
  });

  test("profile budgets cap max-token overrides", () => {
    expect(resolveSnapshotBudget("compact")).toBe(1200);
    expect(resolveSnapshotBudget("risk")).toBe(3000);
    expect(resolveSnapshotBudget("deep")).toBe(5000);
    expect(resolveSnapshotBudget("compact", 3000)).toBe(1200);
    expect(resolveSnapshotBudget("risk", 1000)).toBe(1000);
  });

  test("compact profile renders bounded memory cards with intact metadata", () => {
    const recall: ContextRecallResult = {
      trigger: "braincore_snapshot",
      mode: "shadow",
      injected: false,
      results: [],
      promptPackage: [{
        section: "validated_facts",
        memoryId: "11111111-1111-4111-8111-111111111111",
        role: "fact",
        reason: "braincore-runtime-snapshot",
        content: "Important memory. ".repeat(300),
        tokenCount: 300,
        governanceStatus: "validated",
      }],
      omitted: [],
      totalTokens: 300,
    };

    const markdown = renderBrainCoreSnapshot(
      { cwd: "/workspace/memory", gitRoot: "/workspace/project-root", mode: "shadow", profile: "compact" },
      ["memory", "project-root"],
      recall,
      "compact",
    );

    expect(markdown).toContain("Profile: compact");
    expect(markdown).toContain("Memory ID: 11111111-1111-4111-8111-111111111111");
    expect(markdown).toContain("Governance: validated");
    expect(markdown).toContain("Full narrative retained in BrainCore");
  });
});
