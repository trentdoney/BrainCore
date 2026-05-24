import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { parsePaiAutoMemory } from "../extract/pai-auto-memory-parser";
import { parseVestigeExport } from "../extract/vestige-parser";

describe("assistant memory source parsers", () => {
  test("parses Vestige JSON export into one source item per memory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "braincore-vestige-"));
    const path = join(dir, "vestige.json");
    await writeFile(path, JSON.stringify([
      {
        id: "mem-1",
        content: "Remember that BrainCore imports must stay review gated.",
        nodeType: "decision",
        createdAt: "2026-05-18T00:00:00Z",
        source: "agent-memory-atlas",
        tags: ["braincore", "migration"],
        retentionStrength: 0.77,
        hasEmbedding: true,
        embeddingModel: "nomic-embed-text-v1.5",
      },
    ]));

    const [item] = await parseVestigeExport(path);

    expect(item.sourceType).toBe("vestige_memory");
    expect(item.sourceKey).toBe("vestige_memory:mem-1");
    expect(item.result.scope_path).toBe("assistant:vestige/decision");
    expect(item.result.facts).toContainEqual(expect.objectContaining({
      subject: "vestige_memory:mem-1",
      predicate: "vestige_memory_content",
      fact_kind: "decision",
    }));
    expect(item.result.facts).toContainEqual(expect.objectContaining({
      predicate: "vestige_embedding_model",
      object_value: "nomic-embed-text-v1.5",
    }));
  });

  test("parses PAI auto-memory markdown with provenance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "braincore-pai-auto-"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "feedback_review_gate.md"), `---
name: Review gate
summary: ignored
description: Never skip review gates.
type: feedback
originSessionId: session-1
tags: [braincore]
---
Review gates are required before prompt eligibility.
`);
    await writeFile(join(dir, "MEMORY.md"), "# index only\n");

    const [item] = await parsePaiAutoMemory(dir);

    expect(item.sourceType).toBe("pai_auto_memory");
    expect(item.sourceKey).toBe("pai_auto_memory:feedback_review_gate");
    expect(item.result.scope_path).toBe("assistant:pai/auto/feedback");
    expect(item.result.entities).toContainEqual({ name: "session-1", type: "session" });
    expect(item.result.facts).toContainEqual(expect.objectContaining({
      predicate: "pai_auto_memory_content",
      fact_kind: "constraint",
    }));
  });
});
