import { describe, expect, test } from "bun:test";
import { verify } from "../extract/verify";

describe("LLM extraction validation", () => {
  test("accepts object-valued facts under Zod v4", async () => {
    const result = await verify({
      facts: [
        {
          subject: "braincore",
          predicate: "runtime",
          object_value: {
            status: "healthy",
            confidence_source: "smoke-test",
          },
          fact_kind: "state",
          confidence: 0.93,
          segment_ids: ["segment-1"],
        },
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.valid).not.toBeNull();
    expect(result.valid?.facts[0]?.object_value).toEqual({
      status: "healthy",
      confidence_source: "smoke-test",
    });
  });

  test("reports useful errors for invalid fact shapes", async () => {
    const result = await verify({
      facts: [
        {
          subject: "",
          predicate: "runtime",
          object_value: { status: "invalid" },
          fact_kind: "state",
          confidence: 2,
          segment_ids: [],
        },
      ],
    });

    expect(result.valid).toBeNull();
    expect(result.errors.some((error) => error.startsWith("facts.0.subject:"))).toBe(
      true,
    );
    expect(result.errors.some((error) => error.startsWith("facts.0.confidence:"))).toBe(
      true,
    );
    expect(result.errors.some((error) => error.startsWith("facts.0.segment_ids:"))).toBe(
      true,
    );
  });
});
