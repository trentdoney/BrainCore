import { basename } from "path";
import type postgres from "postgres";
import {
  estimateTokenCount,
  recallForContext,
  type ContextInjectionMode,
  type ContextRecallResult,
} from "./governance";

export interface BrainCoreSnapshotOptions {
  cwd: string;
  gitRoot?: string | null;
  prompt?: string;
  maxTokens?: number;
  mode?: ContextInjectionMode;
  tenant?: string;
  limit?: number;
  profile?: BrainCoreSnapshotProfile;
}

export interface BrainCoreSnapshotResult {
  markdown: string;
  domains: string[];
  recall: ContextRecallResult;
  tokenEstimate: number;
  truncated: boolean;
  profile: BrainCoreSnapshotProfile | "legacy";
}

export type BrainCoreSnapshotProfile = "compact" | "risk" | "deep";

interface SnapshotProfileConfig {
  budget: number;
  maxCards: number;
  bodyTokens: number;
  genericTokenCap: number | null;
  genericCardCap: number | null;
}

const SNAPSHOT_PROFILES: Record<BrainCoreSnapshotProfile, SnapshotProfileConfig> = {
  compact: { budget: 1200, maxCards: 4, bodyTokens: 220, genericTokenCap: 420, genericCardCap: 2 },
  risk: { budget: 3000, maxCards: 5, bodyTokens: 850, genericTokenCap: null, genericCardCap: null },
  deep: { budget: 5000, maxCards: 8, bodyTokens: 1200, genericTokenCap: null, genericCardCap: null },
};

export function resolveSnapshotBudget(profile?: BrainCoreSnapshotProfile, maxTokens?: number): number {
  const profileBudget = profile ? SNAPSHOT_PROFILES[profile].budget : 3000;
  if (!Number.isFinite(maxTokens) || !maxTokens || maxTokens <= 0) return profileBudget;
  return profile ? Math.min(maxTokens, profileBudget) : maxTokens;
}

export async function buildBrainCoreSnapshot(
  sql: postgres.Sql,
  options: BrainCoreSnapshotOptions,
): Promise<BrainCoreSnapshotResult> {
  const domains = resolveSnapshotDomains(options.cwd, options.gitRoot, options.prompt);
  const cues = tokenCues(options.prompt).slice(0, 12);
  const scope = domains[0] ? `project:${domains[0]}` : undefined;
  const maxTokens = resolveSnapshotBudget(options.profile, options.maxTokens);
  const recallMaxTokens = options.profile ? maxTokens * 4 : maxTokens;
  const profileCues = options.profile === "risk"
    ? [...cues, "feedback_pre_push_gate_is_load_bearing", "feedback_codex_review_before_approve", "pre-push", "codex", "review", "github"]
    : cues;
  let recall = await recallForContext(sql, {
    trigger: "braincore_snapshot",
    tenant: options.tenant,
    goal: options.prompt,
    cues: profileCues,
    scope,
    maxTokens: recallMaxTokens,
    injectionMode: options.mode ?? "shadow",
    limit: options.limit ?? 20,
    relevanceReason: "braincore-runtime-snapshot",
    actor: "braincore-snapshot",
    route: "braincore snapshot build",
  });
  if (scope && recall.promptPackage.length === 0 && cues.length > 0) {
    recall = await recallForContext(sql, {
      trigger: "braincore_snapshot_scope_fallback",
      tenant: options.tenant,
      scope,
      maxTokens: recallMaxTokens,
      injectionMode: options.mode ?? "shadow",
      limit: options.limit ?? 20,
      relevanceReason: "braincore-runtime-snapshot-scope-fallback",
      actor: "braincore-snapshot",
      route: "braincore snapshot build fallback",
    });
  }
  const rendered = renderBrainCoreSnapshot({ ...options, mode: options.mode ?? "shadow" }, domains, recall, options.profile);
  const budgeted = enforceSnapshotBudget(rendered, maxTokens);
  return { markdown: budgeted.markdown, domains, recall, tokenEstimate: budgeted.tokenEstimate, truncated: budgeted.truncated, profile: options.profile ?? "legacy" };
}

export function resolveSnapshotDomains(cwd: string, gitRoot?: string | null, _prompt?: string): string[] {
  const values: string[] = [];
  const markerMatch = findProjectMarkerDomain(cwd) ?? (gitRoot ? findProjectMarkerDomain(gitRoot) : null);
  if (markerMatch) values.push(markerMatch);
  const rootName = gitRoot ? basename(gitRoot) : basename(cwd);
  if (rootName && rootName !== "." && rootName !== "/") values.push(rootName);
  return [...new Set(values.map(sanitizeDomain).filter(Boolean))];
}

function findProjectMarkerDomain(inputPath: string): string | null {
  const markers = (process.env.BRAINCORE_PROJECT_DOMAIN_MARKERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (markers.length === 0) return null;

  const segments = inputPath.split(/[\/]+/).filter(Boolean);
  for (const marker of markers) {
    const index = segments.indexOf(marker);
    if (index >= 0 && segments[index + 1]) return segments[index + 1];
  }
  return null;
}

export function renderBrainCoreSnapshot(
  options: BrainCoreSnapshotOptions,
  domains: string[],
  recall: ContextRecallResult,
  profile?: BrainCoreSnapshotProfile,
): string {
  const profileConfig = profile ? SNAPSHOT_PROFILES[profile] : null;
  const promptPackage = profileConfig ? selectProfilePromptPackage(recall, profileConfig) : recall.promptPackage;
  const lines: string[] = [];
  lines.push("Use the following BrainCore memory snapshot as supporting context only.");
  lines.push("If it conflicts with the live repo, runtime, or direct instructions, trust the live repo and direct instructions.");
  lines.push("");
  lines.push("# BrainCore Memory Snapshot");
  lines.push("");
  lines.push(`Context cwd: ${options.cwd}`);
  if (options.gitRoot) lines.push(`Context git root: ${options.gitRoot}`);
  lines.push(`Candidate domains: ${domains.join(", ") || "none"}`);
  lines.push(`Profile: ${profile ?? "legacy"}`);
  lines.push(`Mode: ${recall.mode}`);
  lines.push(`Injected: ${recall.injected ? "yes" : "no"}`);
  lines.push(`Prompt-eligible memories: ${promptPackage.length}`);
  lines.push(`Retrieved memories: ${recall.results.length}`);
  lines.push("");

  if (promptPackage.length === 0) {
    lines.push("## No Prompt-Eligible BrainCore Memories");
    lines.push("");
    lines.push("BrainCore returned no reviewed memories for this snapshot. Imported assistant memories remain gated until explicitly approved.");
  } else {
    lines.push("## Memories");
    lines.push("");
    for (const item of promptPackage) {
      lines.push(`### ${item.section}`);
      lines.push(`- Memory ID: ${item.memoryId}`);
      lines.push(`- Reason: ${item.reason}`);
      lines.push(`- Tokens: ${item.tokenCount}`);
      if (item.governanceStatus) lines.push(`- Governance: ${item.governanceStatus}`);
      lines.push("");
      lines.push(profileConfig ? compactMemoryContent(item.content, profileConfig.bodyTokens) : item.content);
      lines.push("");
    }
  }

  if (recall.omitted.length > 0) {
    lines.push("## Omitted");
    lines.push("");
    for (const omitted of recall.omitted) {
      lines.push(`- ${omitted.memoryId}: ${omitted.reason}`);
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

function selectProfilePromptPackage(recall: ContextRecallResult, profileConfig: SnapshotProfileConfig): ContextRecallResult["promptPackage"] {
  const selected: ContextRecallResult["promptPackage"] = [];
  let genericTokens = 0;
  let genericCards = 0;
  const ranked = [...recall.promptPackage].sort((left, right) => safetyPriority(right) - safetyPriority(left));
  for (const item of ranked) {
    if (selected.length >= profileConfig.maxCards) break;
    const generic = isGenericFallback(item);
    const tokenCost = Math.min(item.tokenCount, profileConfig.bodyTokens + 80);
    if (generic) {
      if (profileConfig.genericCardCap !== null && genericCards >= profileConfig.genericCardCap) continue;
      if (profileConfig.genericTokenCap !== null && genericTokens + tokenCost > profileConfig.genericTokenCap) continue;
      genericCards++;
      genericTokens += tokenCost;
    }
    selected.push({ ...item, tokenCount: tokenCost });
  }
  return selected;
}

function safetyPriority(item: ContextRecallResult["promptPackage"][number]): number {
  const text = `${item.memoryId} ${item.content}`.toLowerCase();
  let score = 0;
  if (text.includes("83856999-727b-42f8-b826-8e1eebb6208b") || text.includes("pre-push sanitization gate")) score += 100;
  if (text.includes("0fbc63fc-6991-47b7-8f7a-d138f12c8276") || text.includes("codex review plans")) score += 90;
  if (/\b(github|gitea|public|security|secret|sanitize|merge|dependabot|migration|rollback|incident)\b/i.test(text)) score += 10;
  return score;
}

function isGenericFallback(item: ContextRecallResult["promptPackage"][number]): boolean {
  return /fallback/i.test(item.reason) || item.reason === "braincore-runtime-snapshot-scope-fallback";
}

function compactMemoryContent(content: string, maxTokens: number): string {
  const budget = Math.max(1, maxTokens * 4);
  if (estimateTokens(content) <= maxTokens) return content;
  return `${content.slice(0, budget).trimEnd()}\n\n[Full narrative retained in BrainCore.]`;
}

function sanitizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function tokenCues(value?: string): string[] {
  if (!value) return [];
  return value
    .split(/[^A-Za-z0-9_-]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4)
    .slice(0, 8);
}

function estimateTokens(value: string): number {
  return estimateTokenCount(value);
}

function enforceSnapshotBudget(markdown: string, maxTokens: number): { markdown: string; tokenEstimate: number; truncated: boolean } {
  const tokenEstimate = estimateTokens(markdown);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0 || tokenEstimate <= maxTokens) {
    return { markdown, tokenEstimate, truncated: false };
  }
  const suffix = "\n\n## Budget Notice\n\nSnapshot truncated to respect the configured token budget.\n";
  const suffixTokens = estimateTokens(suffix);
  const contentBudget = Math.max(1, maxTokens - suffixTokens);
  let truncated = markdown.slice(0, Math.max(1, contentBudget * 4)).trimEnd() + suffix;
  while (estimateTokens(truncated) > maxTokens && truncated.length > suffix.length + 16) {
    truncated = truncated.slice(0, Math.max(suffix.length + 16, truncated.length - 64)).trimEnd() + suffix;
  }
  return { markdown: truncated, tokenEstimate: estimateTokens(truncated), truncated: true };
}
