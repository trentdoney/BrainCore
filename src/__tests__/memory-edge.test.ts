import { describe, expect, test } from "bun:test";

import { memoryEdgeFingerprint } from "../consolidate/edges";

describe("memory edge fingerprint", () => {
  test("is stable and directed", () => {
    const first = memoryEdgeFingerprint({
      tenant: "tenant-a",
      sourceType: "fact",
      sourceId: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
      edgeType: "caused_by",
      targetType: "memory",
      targetId: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB",
      scopePath: "project:braincore",
    });
    const same = memoryEdgeFingerprint({
      tenant: "tenant-a",
      sourceType: "fact",
      sourceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      edgeType: "caused_by",
      targetType: "memory",
      targetId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      scopePath: "project:braincore",
    });
    const reversed = memoryEdgeFingerprint({
      tenant: "tenant-a",
      sourceType: "memory",
      sourceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      edgeType: "caused_by",
      targetType: "fact",
      targetId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      scopePath: "project:braincore",
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(same);
    expect(first).not.toBe(reversed);
  });
});
