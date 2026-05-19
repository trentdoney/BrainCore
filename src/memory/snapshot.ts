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
}

export interface BrainCoreSnapshotResult {
  markdown: string;
  domains: string[];
  recall: ContextRecallResult;
  tokenEstimate: number;
  truncated: boolean;
}

export async function buildBrainCoreSnapshot(
  sql: postgres.Sql,
  options: BrainCoreSnapshotOptions,
): Promise<BrainCoreSnapshotResult> {
  const domains = resolveSnapshotDomains(options.cwd, options.gitRoot, options.prompt);
  const cues = tokenCues(options.prompt).slice(0, 12);
  const scope = domains[0] ? `project:${domains[0]}` : undefined;
  let recall = await recallForContext(sql, {
    trigger: "braincore_snapshot",
    tenant: options.tenant,
    goal: options.prompt,
    cues,
    scope,
    maxTokens: options.maxTokens ?? 3000,
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
      maxTokens: options.maxTokens ?? 3000,
      injectionMode: options.mode ?? "shadow",
      limit: options.limit ?? 20,
      relevanceReason: "braincore-runtime-snapshot-scope-fallback",
      actor: "braincore-snapshot",
      route: "braincore snapshot build fallback",
    });
  }
  const rendered = renderBrainCoreSnapshot({ ...options, mode: options.mode ?? "shadow" }, domains, recall);
  const budgeted = enforceSnapshotBudget(rendered, options.maxTokens ?? 3000);
  return { markdown: budgeted.markdown, domains, recall, tokenEstimate: budgeted.tokenEstimate, truncated: budgeted.truncated };
}

export function resolveSnapshotDomains(cwd: string, gitRoot?: string | null, prompt?: string): string[] {
  const values: string[] = [];
  const match = cwd.match(/(?:^|\/)10_projects\/([^/]+)/) ?? gitRoot?.match(/(?:^|\/)10_projects\/([^/]+)/);
  if (match?.[1]) values.push(match[1]);
  const rootName = gitRoot ? basename(gitRoot) : basename(cwd);
  if (rootName && rootName !== "." && rootName !== "/") values.push(rootName);
  values.push(...tokenCues(prompt).slice(0, 4));
  return [...new Set(values.map(sanitizeDomain).filter(Boolean))];
}

export function renderBrainCoreSnapshot(
  options: BrainCoreSnapshotOptions,
  domains: string[],
  recall: ContextRecallResult,
): string {
  const lines: string[] = [];
  lines.push("Use the following BrainCore memory snapshot as supporting context only.");
  lines.push("If it conflicts with the live repo, runtime, or direct instructions, trust the live repo and direct instructions.");
  lines.push("");
  lines.push("# BrainCore Memory Snapshot");
  lines.push("");
  lines.push(`Context cwd: ${options.cwd}`);
  if (options.gitRoot) lines.push(`Context git root: ${options.gitRoot}`);
  lines.push(`Candidate domains: ${domains.join(", ") || "none"}`);
  lines.push(`Mode: ${recall.mode}`);
  lines.push(`Injected: ${recall.injected ? "yes" : "no"}`);
  lines.push(`Prompt-eligible memories: ${recall.promptPackage.length}`);
  lines.push(`Retrieved memories: ${recall.results.length}`);
  lines.push("");

  if (recall.promptPackage.length === 0) {
    lines.push("## No Prompt-Eligible BrainCore Memories");
    lines.push("");
    lines.push("BrainCore returned no reviewed memories for this snapshot. Imported assistant memories remain gated until explicitly approved.");
  } else {
    lines.push("## Memories");
    lines.push("");
    for (const item of recall.promptPackage) {
      lines.push(`### ${item.section}`);
      lines.push(`- Memory ID: ${item.memoryId}`);
      lines.push(`- Reason: ${item.reason}`);
      lines.push(`- Tokens: ${item.tokenCount}`);
      if (item.governanceStatus) lines.push(`- Governance: ${item.governanceStatus}`);
      lines.push("");
      lines.push(item.content);
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
