/**
 * semantic.ts — LLM-based extraction for fuzzy fields.
 * Takes deterministic segments and facts, sends them to a local LLM for
 * deeper analysis. All facts tagged assertion_class='single_source_llm'.
 *
 * The LLM client now automatically falls back to Haiku when GPU is offline,
 * so this function always gets a response (or throws on total failure).
 */

import { LLMClient, type LLMResponse } from "../llm/client";
import { config } from "../config";
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
  provider: "vllm" | "claude-cli" | "skipped";
  durationMs: number;
  warnings: string[];
  reviewReasons: string[];
  redactionDetected: boolean;
  truncated: boolean;
}

const PROMPT_INJECTION_MARKERS = [
  "ignore previous",
  "ignore above",
  "system:",
  "developer:",
  "assistant:",
  "you are now",
  "act as",
  "follow these instructions instead",
  "<|im_start|>",
  "<|system|>",
  "begin prompt",
  "role:",
];

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function findPromptInjectionMarker(text: string): string | null {
  const lower = text.toLowerCase();
  for (const marker of PROMPT_INJECTION_MARKERS) {
    if (lower.includes(marker)) {
      return marker;
    }
  }
  return null;
}

function capSegmentsForPrompt(segments: SegmentInput[]): {
  segments: SegmentInput[];
  truncated: boolean;
} {
  const kept: SegmentInput[] = [];
  let totalChars = 0;
  let truncated = false;

  for (const seg of segments) {
    if (kept.length >= config.limits.maxSegmentsPerPrompt) {
      truncated = true;
      break;
    }

    const remaining = config.limits.maxPromptChars - totalChars;
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    if (seg.content.length <= remaining) {
      kept.push(seg);
      totalChars += seg.content.length;
      continue;
    }

    kept.push({ ...seg, content: seg.content.slice(0, remaining) });
    truncated = true;
    break;
  }

  return { segments: kept, truncated };
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
  const promptInjectionMarker = findPromptInjectionMarker(
    segments.map((s) => s.content).join("\n\n"),
  );
  if (promptInjectionMarker) {
    return {
      facts: [],
      lessons: [],
      questions: [],
      model: "prompt-injection-guard",
      provider: "skipped",
      durationMs: 0,
      warnings: [`Prompt injection heuristic matched: ${promptInjectionMarker}`],
      reviewReasons: ["prompt_injection_suspected"],
      redactionDetected: false,
      truncated: false,
    };
  }

  const redactedSegments = segments.map((s) => {
    const redaction = redactSecrets(s.content);
    return {
      ...s,
      content: redaction.redacted,
      secretsFound: redaction.secretsFound,
    };
  });
  const redactionDetected = redactedSegments.some((s) => s.secretsFound > 0);
  const { segments: cappedSegments, truncated } = capSegmentsForPrompt(
    redactedSegments.map(({ secretsFound: _secretsFound, ...seg }) => seg),
  );

  // Build prompt
  const userMessage = buildIncidentUserPrompt(cappedSegments, deterministicFacts);
  const reviewReasons: string[] = [];
  const warnings: string[] = [];
  if (redactionDetected) {
    reviewReasons.push("redaction_detected");
  }
  if (truncated) {
    reviewReasons.push("semantic_truncated");
    warnings.push("Semantic input was truncated to fit prompt limits");
  }

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
  const verification = await verify(response.content);
  const verifyWarnings = verification.warnings;
  const errors = verification.errors;
  const valid = verification.valid;
  if (!valid) {
    console.error("  [semantic] LLM output failed Zod validation:");
    for (const err of errors) console.error(`    - ${err}`);
    return null;
  }

  if (verifyWarnings.length > 0) {
    console.error("  [semantic] Warnings:");
    for (const w of verifyWarnings) console.error(`    - ${w}`);
    reviewReasons.push("verify_warning");
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
    warnings: [...warnings, ...verifyWarnings],
    reviewReasons: unique(reviewReasons),
    redactionDetected,
    truncated,
  };
}
