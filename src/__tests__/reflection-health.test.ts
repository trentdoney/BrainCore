import { describe, expect, test } from "bun:test";
import {
  classifyMemoryHealth,
  createBeliefCandidate,
  hasEvidenceSource,
  reflectionFingerprint,
  requireEvidenceLinks,
} from "../reflection/health";

describe("reflection health helpers", () => {
  test("requires evidence links for derived reflection items", () => {
    expect(hasEvidenceSource({})).toBe(false);
    expect(hasEvidenceSource({ segmentId: "55555555-5555-5555-5555-555555555555" })).toBe(true);
    expect(() => requireEvidenceLinks([{}])).toThrow("evidence link");
  });

  test("builds stable evidence-linked fingerprints independent of evidence order", () => {
    const first = reflectionFingerprint({
      tenant: "tenant-a",
      kind: "entity_summary",
      subjectId: "11111111-1111-1111-1111-111111111111",
      scopePath: "project:braincore",
      statement: "Service has repeated restart failures",
      evidence: [
        { factId: "22222222-2222-2222-2222-222222222222" },
        { segmentId: "33333333-3333-3333-3333-333333333333" },
      ],
    });
    const second = reflectionFingerprint({
      tenant: "TENANT-A",
      kind: "entity_summary",
      subjectId: "11111111-1111-1111-1111-111111111111",
      scopePath: "project:braincore",
      statement: " service has repeated restart failures ",
      evidence: [
        { segmentId: "33333333-3333-3333-3333-333333333333" },
        { factId: "22222222-2222-2222-2222-222222222222" },
      ],
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  test("keeps beliefs distinct from fact-shaped candidates", () => {
    const candidate = createBeliefCandidate({
      tenant: "tenant-a",
      beliefText: "The service probably fails after long idle periods",
      confidence: 1.4,
      subjectId: "11111111-1111-1111-1111-111111111111",
      evidence: [{ segmentId: "33333333-3333-3333-3333-333333333333" }],
    });

    expect(candidate.kind).toBe("belief");
    expect(candidate).not.toHaveProperty("factKind");
    expect(candidate.confidence).toBe(1);
    expect(candidate.beliefFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test("classifies memory health from support and staleness metrics", () => {
    expect(classifyMemoryHealth({
      totalMemoryCount: 100,
      unsupportedCount: 0,
      staleCount: 0,
      contradictionCount: 0,
    })).toBe("healthy");
    expect(classifyMemoryHealth({
      totalMemoryCount: 100,
      unsupportedCount: 1,
      staleCount: 0,
      contradictionCount: 0,
    })).toBe("watch");
    expect(classifyMemoryHealth({
      totalMemoryCount: 100,
      unsupportedCount: 12,
      staleCount: 0,
      contradictionCount: 0,
    })).toBe("degraded");
    expect(classifyMemoryHealth({
      totalMemoryCount: 100,
      unsupportedCount: 0,
      staleCount: 0,
      contradictionCount: 1,
    })).toBe("critical");
  });
});
