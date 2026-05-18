import { describe, expect, test } from "bun:test";
import { renderBrainCoreSnapshot, resolveSnapshotDomains } from "../memory/snapshot";
import type { ContextRecallResult } from "../memory/governance";

describe("BrainCore snapshot", () => {
  test("infers workspace project domain from cwd", () => {
    const domains = resolveSnapshotDomains(
      "/workspace/10_projects/Memory",
      "/workspace/workspace",
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
      { cwd: "/workspace/10_projects/Memory", gitRoot: "/workspace/workspace", mode: "shadow" },
      ["memory"],
      recall,
    );

    expect(markdown).toContain("# BrainCore Memory Snapshot");
    expect(markdown).toContain("Candidate domains: memory");
    expect(markdown).toContain("No Prompt-Eligible BrainCore Memories");
    expect(markdown).toContain("remain gated until explicitly approved");
  });
});
