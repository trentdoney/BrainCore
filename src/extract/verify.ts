/**
 * verify.ts — Zod validation + contradiction checking for LLM extractions.
 * Validates raw LLM output against the ExtractionSchema before it touches the database.
 */

import { z } from "zod";

export const FactSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object_value: z
    .union([z.string(), z.number(), z.boolean(), z.record(z.unknown())])
    .nullable(),
  fact_kind: z.enum([
    "state",
    "cause",
    "impact",
    "decision",
    "remediation",
    "lesson",
    "constraint",
    "config_change",
    "event",
  ]),
  confidence: z.number().min(0).max(1),
  segment_ids: z.array(z.string()).min(1),
  status: z.enum(["confirmed", "hypothesis"]).default("confirmed"),
});

export const LessonSchema = z.object({
  description: z.string().min(1),
  confidence: z.number().min(0).max(1),
  segment_ids: z.array(z.string()).min(1),
});

export const QuestionSchema = z.object({
  text: z.string().min(1),
  segment_ids: z.array(z.string()),
});

export const ExtractionSchema = z.object({
  facts: z.array(FactSchema),
  lessons: z.array(LessonSchema).optional().default([]),
  questions: z.array(QuestionSchema).optional().default([]),
});

export type ValidExtraction = z.infer<typeof ExtractionSchema>;
export type ValidFact = z.infer<typeof FactSchema>;

/**
 * Check for obvious contradictions within a fact set.
 * Returns warnings (not blocking errors) for human review.
 */
function findContradictions(
  facts: ValidFact[],
): string[] {
  const warnings: string[] = [];
  const stateBySubject = new Map<string, ValidFact[]>();

  for (const fact of facts) {
    if (fact.fact_kind === "state") {
      const key = `${fact.subject}::${fact.predicate}`;
      if (!stateBySubject.has(key)) stateBySubject.set(key, []);
      stateBySubject.get(key)!.push(fact);
    }
  }

  // Flag same (subject, predicate) with different object_value at high confidence
  for (const [key, group] of stateBySubject) {
    if (group.length < 2) continue;
    const values = group.map((f) => JSON.stringify(f.object_value));
    const unique = [...new Set(values)];
    if (unique.length > 1) {
      const highConf = group.filter((f) => f.confidence >= 0.8);
      if (highConf.length > 1) {
        warnings.push(
          `Contradiction: ${key} has ${unique.length} different values at high confidence: ${unique.join(", ")}`,
        );
      }
    }
  }

  return warnings;
}

/**
 * Validate raw LLM output against the extraction schema.
 * Returns { valid, errors, warnings }.
 */
export async function verify(raw: unknown): Promise<{
  valid: ValidExtraction | null;
  errors: string[];
  warnings: string[];
}> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Handle string input (raw JSON from LLM)
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      // Strip markdown fences if present
      let cleaned = (raw as string).trim();
      if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      }
      parsed = JSON.parse(cleaned);
    } catch (e: any) {
      errors.push(`JSON parse error: ${e.message}`);
      return { valid: null, errors, warnings };
    }
  }

  // Pre-processing: coerce LLM output quirks before strict validation
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).facts)) {
    const VALID_FACT_KINDS = new Set([
      "state", "cause", "impact", "decision", "remediation",
      "lesson", "constraint", "config_change", "event",
    ]);
    const FACT_KIND_MAP: Record<string, string> = {
      verification: "state",
      requirement: "constraint",
      dependency: "constraint",
      observation: "state",
      action: "remediation",
      fix: "remediation",
      prevention: "remediation",
      context: "state",
      symptom: "impact",
      trigger: "cause",
      workaround: "remediation",
      recommendation: "lesson",
    };

    for (const fact of (parsed as any).facts) {
      // Coerce unknown fact_kind to nearest valid value
      if (fact.fact_kind && !VALID_FACT_KINDS.has(fact.fact_kind)) {
        const mapped = FACT_KIND_MAP[fact.fact_kind.toLowerCase()];
        if (mapped) {
          warnings.push(`Coerced fact_kind "${fact.fact_kind}" -> "${mapped}"`);
          fact.fact_kind = mapped;
        } else {
          warnings.push(`Unknown fact_kind "${fact.fact_kind}" -> "state"`);
          fact.fact_kind = "state";
        }
      }

      // Coerce array object_value to string (join)
      if (Array.isArray(fact.object_value)) {
        fact.object_value = fact.object_value.map((v: any) => String(v)).join(", ");
      }
    }
  }

  // Zod parse
  const result = ExtractionSchema.safeParse(parsed);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(`${issue.path.join(".")}: ${issue.message}`);
    }
    return { valid: null, errors, warnings };
  }

  // Contradiction check (non-blocking)
  const contradictions = findContradictions(result.data.facts);
  warnings.push(...contradictions);

  // Segment reference check — warn about empty segment_ids
  for (let i = 0; i < result.data.facts.length; i++) {
    const fact = result.data.facts[i];
    if (fact.segment_ids.length === 0) {
      warnings.push(`facts[${i}]: no segment_ids referenced`);
    }
  }

  return { valid: result.data, errors, warnings };
}
