/**
 * incident.ts — LLM extraction prompts for incident analysis.
 * Defines the system prompt, user prompt builder, and expected JSON schema
 * for semantic extraction from incident documentation.
 */

export const INCIDENT_SYSTEM_PROMPT = `You are a precise technical analyst extracting structured knowledge from infrastructure incident reports.

Your task: Given incident segments and deterministic facts already extracted, identify ADDITIONAL semantic knowledge that cannot be parsed deterministically.

## Rules

1. Every fact MUST reference at least one segment_id from the provided segments.
2. Use "confirmed" status for facts clearly stated in the text. Use "hypothesis" for inferred or speculative facts.
3. Use "unknown" for any field you cannot determine — NEVER guess or fabricate.
4. Do NOT repeat facts already provided in the deterministic extraction.
5. Focus on: root cause chains, impact relationships, decision rationale, lessons learned, and unresolved questions.
6. Confidence scores: 1.0 = explicitly stated, 0.8-0.9 = strongly implied, 0.5-0.7 = inferred from context, <0.5 = weak inference.

## Output JSON Schema

{
  "facts": [
    {
      "subject": "string — entity or concept name",
      "predicate": "string — relationship type (e.g., caused_by, impacts, requires, mitigates)",
      "object_value": "string or object — the target or value",
      "fact_kind": "cause | impact | decision | remediation | lesson | constraint | config_change",
      "confidence": 0.0-1.0,
      "segment_ids": ["seg_id_1"],
      "status": "confirmed | hypothesis"
    }
  ],
  "lessons": [
    {
      "description": "string — actionable lesson learned",
      "confidence": 0.0-1.0,
      "segment_ids": ["seg_id_1"]
    }
  ],
  "questions": [
    {
      "text": "string — unresolved question from the incident",
      "segment_ids": ["seg_id_1"]
    }
  ]
}

Respond with ONLY the JSON object. No markdown fences, no commentary.`;

export interface SegmentInput {
  id: string;
  section_label: string;
  content: string;
}

export function buildIncidentUserPrompt(
  segments: SegmentInput[],
  deterministicFacts: Array<{
    subject: string;
    predicate: string;
    object_value: any;
  }>,
): string {
  const segmentBlock = segments
    .map((s) => `--- Segment ${s.id} [${s.section_label}] ---\n${s.content}`)
    .join("\n\n");

  const factBlock = deterministicFacts
    .map(
      (f) =>
        `- (${f.subject}, ${f.predicate}, ${JSON.stringify(f.object_value)})`,
    )
    .join("\n");

  return `## Incident Segments

${segmentBlock}

## Already-Extracted Deterministic Facts (DO NOT REPEAT)

${factBlock}

Extract additional semantic facts, lessons, and unresolved questions. Output JSON only.`;
}
