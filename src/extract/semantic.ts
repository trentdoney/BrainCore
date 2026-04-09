/**
 * semantic.ts — LLM-based extraction for fuzzy fields.
 * Takes deterministic segments and facts, sends them to a local LLM for
 * deeper analysis. All facts tagged assertion_class='single_source_llm'.
 *
 * The LLM client now automatically falls back to Haiku when GPU is offline,
 * so this function always gets a response (or throws on total failure).
 */

import { LLMClient, type LLMResponse } from "../llm/client";
import {
  INCIDENT_SYSTEM_PROMPT,
  buildIncidentUserPrompt,
  type SegmentInput,
} from "../llm/prompts/incident";
import { verify, type ValidExtraction } from "./verify";
import { redactSecrets } from "../security/secret-scanner";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SemanticFact {
  subject: string;
  predicate: string;
  object_value: any;
  fact_kind: string;
  assertion_class: "single_source_llm";
  confidence: number;
  segment_ids: string[];
  status: "confirmed" | "hypothesis";
}

export interface Lesson {
  description: string;
  confidence: number;
  segment_ids: string[];
}

export interface Question {
  text: string;
  segment_ids: string[];
}

export interface SemanticResult {
  facts: SemanticFact[];
  lessons: Lesson[];
  questions: Question[];
  model: string;
  provider: "vllm" | "claude-cli";
  durationMs: number;
  warnings: string[];
}

// ── Main Extraction ────────────────────────────────────────────────────────────

export async function extractSemantic(
  segments: SegmentInput[],
  deterministicFacts: Array<{
    subject: string;
    predicate: string;
    object_value: any;
  }>,
  llmClient: LLMClient,
  opts?: { useClaude?: boolean },
): Promise<SemanticResult | null> {
  // Redact secrets from segment content before sending to LLM
  const redactedSegments = segments.map((s) => ({
    ...s,
    content: redactSecrets(s.content).redacted,
  }));

  // Build prompt
  const userMessage = buildIncidentUserPrompt(redactedSegments, deterministicFacts);

  // Call LLM — complete() now always returns a result (vLLM or Haiku fallback)
  let response: LLMResponse;

  if (opts?.useClaude) {
    console.error("  [semantic] Escalating to Claude CLI (explicit request)");
    response = await llmClient.completeWithClaude({
      systemPrompt: INCIDENT_SYSTEM_PROMPT,
      userMessage,
      maxTokens: 4096,
      temperature: 0.1,
      jsonMode: true,
    });
  } else {
    try {
      response = await llmClient.complete({
        systemPrompt: INCIDENT_SYSTEM_PROMPT,
        userMessage,
        maxTokens: 4096,
        temperature: 0.1,
        jsonMode: true,
      });
    } catch (e: any) {
      console.error(`  [semantic] LLM completely unavailable (vLLM + Haiku): ${e.message}`);
      return null;
    }
  }

  console.error(
    `  [semantic] Got response from ${response.provider}/${response.model} in ${response.durationMs}ms`,
  );

  // Parse and verify
  const { valid, errors, warnings } = await verify(response.content);
  if (!valid) {
    console.error("  [semantic] LLM output failed Zod validation:");
    for (const err of errors) console.error(`    - ${err}`);
    return null;
  }

  if (warnings.length > 0) {
    console.error("  [semantic] Warnings:");
    for (const w of warnings) console.error(`    - ${w}`);
  }

  // Tag all facts with single_source_llm assertion class
  const facts: SemanticFact[] = valid.facts.map((f) => ({
    ...f,
    assertion_class: "single_source_llm" as const,
    object_value: f.object_value,
    status: f.status as "confirmed" | "hypothesis",
  }));

  const lessons: Lesson[] = (valid.lessons || []).map((l) => ({
    description: l.description,
    confidence: l.confidence,
    segment_ids: l.segment_ids,
  }));

  const questions: Question[] = (valid.questions || []).map((q) => ({
    text: q.text,
    segment_ids: q.segment_ids,
  }));

  return {
    facts,
    lessons,
    questions,
    model: response.model,
    provider: response.provider,
    durationMs: response.durationMs,
    warnings,
  };
}
