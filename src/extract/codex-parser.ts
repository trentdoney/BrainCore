/**
 * codex-parser.ts — Parse OpenAI Codex CLI history and session files.
 * 
 * Sources:
 *   1. ~/.codex/history.jsonl — NDJSON, each line: { session_id, ts, text }
 *   2. ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — NDJSON session transcripts
 *
 * Session JSONL types:
 *   - session_meta: { id, timestamp, cwd, originator, cli_version }
 *   - response_item: { type: "message"|"function_call"|"function_call_output"|"reasoning", ... }
 *   - event_msg: { type: "agent_reasoning"|"token_count"|"user_message", ... }
 *   - turn_context: { cwd, model, effort, ... }
 *
 * Extracts:
 *   - Tool calls (shell_command, file ops) -> facts(assertion_class='deterministic')
 *   - File paths mentioned -> entity references
 *   - Working directory -> project resolution
 *   - Model/effort choices -> facts
 *
 * Returns DeterministicResult compatible with load.ts.
 */

import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import type { DeterministicResult, Entity, Fact, Segment, Episode } from "./deterministic";

const CODEX_DIR = process.env.CODEX_DIR || "./data/codex";

// ── History Entry ──────────────────────────────────────────────────────────────

interface HistoryEntry {
  session_id: string;
  ts: number;
  text: string;
}

// ── Session JSONL Types ────────────────────────────────────────────────────────

interface SessionLine {
  timestamp?: string;
  type?: string;
  payload?: any;
}

interface SessionMeta {
  id: string;
  timestamp: string;
  cwd: string;
  originator: string;
  cli_version: string;
  instructions?: string;
}

// ── Parse history.jsonl ────────────────────────────────────────────────────────

function parseHistoryLine(line: string): HistoryEntry | null {
  try {
    const obj = JSON.parse(line.trim());
    if (obj.session_id && obj.ts !== undefined && obj.text !== undefined) {
      return obj as HistoryEntry;
    }
  } catch {}
  return null;
}

// ── Parse session rollout JSONL ────────────────────────────────────────────────

function parseSessionLines(raw: string): SessionLine[] {
  const results: SessionLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      results.push(JSON.parse(line));
    } catch {}
  }
  return results;
}

// ── Extract tool calls from session ────────────────────────────────────────────

interface ToolCallInfo {
  name: string;
  args: string;
  timestamp?: string;
}

function extractToolCalls(lines: SessionLine[]): ToolCallInfo[] {
  const calls: ToolCallInfo[] = [];
  for (const line of lines) {
    if (line.type === "response_item" && line.payload?.type === "function_call") {
      calls.push({
        name: line.payload.name || "unknown",
        args: line.payload.arguments || "{}",
        timestamp: line.timestamp,
      });
    }
  }
  return calls;
}

// ── Extract file paths from tool calls and messages ────────────────────────────

function extractFilePaths(lines: SessionLine[]): Set<string> {
  const paths = new Set<string>();
  const pathRegex = /(?:^|\s|["'`])(\/[\w./-]+(?:\.\w{1,10})?)/g;

  for (const line of lines) {
    const payload = line.payload;
    if (!payload) continue;

    // From function_call arguments
    if (payload.type === "function_call" && payload.arguments) {
      try {
        const args = JSON.parse(payload.arguments);
        if (args.command) {
          for (const match of args.command.matchAll(pathRegex)) {
            if (match[1].length > 3) paths.add(match[1]);
          }
        }
        if (args.workdir) paths.add(args.workdir);
      } catch {}
    }

    // From function_call_output
    if (payload.type === "function_call_output" && payload.output) {
      const output = String(payload.output);
      for (const match of output.matchAll(pathRegex)) {
        if (match[1].length > 3 && !match[1].includes("...")) {
          paths.add(match[1]);
        }
      }
    }
  }

  return paths;
}

// ── Extract session metadata ───────────────────────────────────────────────────

function extractSessionMeta(lines: SessionLine[]): SessionMeta | null {
  for (const line of lines) {
    if (line.type === "session_meta" && line.payload) {
      return line.payload as SessionMeta;
    }
  }
  return null;
}

// ── Extract model info from turn_context ───────────────────────────────────────

function extractModelInfo(lines: SessionLine[]): { model: string; effort: string } | null {
  for (const line of lines) {
    if (line.type === "turn_context" && line.payload?.model) {
      return {
        model: line.payload.model,
        effort: line.payload.effort || "default",
      };
    }
  }
  return null;
}

// ── Extract user messages ──────────────────────────────────────────────────────

function extractUserMessages(lines: SessionLine[]): string[] {
  const messages: string[] = [];
  for (const line of lines) {
    if (line.type === "event_msg" && line.payload?.type === "user_message") {
      const msg = line.payload.message;
      if (msg && typeof msg === "string") {
        messages.push(msg.slice(0, 500));
      }
    }
  }
  return messages;
}

// ── Extract shell commands ─────────────────────────────────────────────────────

function extractShellCommands(toolCalls: ToolCallInfo[]): string[] {
  const commands: string[] = [];
  for (const call of toolCalls) {
    if (call.name === "shell_command") {
      try {
        const args = JSON.parse(call.args);
        if (args.command) commands.push(args.command.slice(0, 300));
      } catch {}
    }
  }
  return commands;
}

// ── Resolve project name from CWD ──────────────────────────────────────────────

function resolveProject(cwd: string): string {
  // Extract meaningful project name from path
  const parts = cwd.split("/").filter(Boolean);
  // Common patterns: /srv/tools/X, /home/user/X, /home/user/OpsVault/X
  if (parts.includes("tools") || parts.includes("projects")) {
    const idx = Math.max(parts.indexOf("tools"), parts.indexOf("projects"));
    return parts.slice(idx + 1).join("/") || parts[parts.length - 1];
  }
  if (parts.includes("OpsVault")) {
    const idx = parts.indexOf("OpsVault");
    return parts.slice(idx).join("/") || "OpsVault";
  }
  return parts[parts.length - 1] || "unknown";
}

// ── Main: Parse all Codex history + sessions ───────────────────────────────────

/**
 * Parse Codex history.jsonl and all session rollout files.
 * Returns a combined DeterministicResult for all sessions found.
 */
export async function parseCodexHistory(
  codexDir?: string,
): Promise<DeterministicResult> {
  const dir = codexDir || CODEX_DIR;
  const historyPath = join(dir, "history.jsonl");
  const sessionsDir = join(dir, "sessions");

  const allEntities: Entity[] = [];
  const allFacts: Fact[] = [];
  const allSegments: Segment[] = [];
  let segOrdinal = 0;

  // ── Parse history.jsonl ────────────────────────────────────────────────
  const historyEntries: HistoryEntry[] = [];
  if (existsSync(historyPath)) {
    const raw = await readFile(historyPath, "utf-8");
    for (const line of raw.split("\n")) {
      const entry = parseHistoryLine(line);
      if (entry) historyEntries.push(entry);
    }
  }

  // Group history entries by session_id
  const sessionPrompts = new Map<string, HistoryEntry[]>();
  for (const entry of historyEntries) {
    const existing = sessionPrompts.get(entry.session_id) || [];
    existing.push(entry);
    sessionPrompts.set(entry.session_id, existing);
  }

  // ── Find and parse session rollout files ───────────────────────────────
  const sessionFiles: string[] = [];
  if (existsSync(sessionsDir)) {
    await collectSessionFiles(sessionsDir, sessionFiles);
  }

  let sessionsProcessed = 0;
  for (const sessionFile of sessionFiles) {
    const raw = await readFile(sessionFile, "utf-8");
    const lines = parseSessionLines(raw);
    if (lines.length === 0) continue;

    sessionsProcessed++;
    const meta = extractSessionMeta(lines);
    const sessionId = meta?.id || basename(sessionFile, ".jsonl");
    const cwd = meta?.cwd || "/unknown";
    const projectName = resolveProject(cwd);

    // Entity: the session itself
    allEntities.push({ name: sessionId, type: "session" as any });

    // Entity: the project
    allEntities.push({ name: projectName, type: "project" as any });

    const segRef = [`seg_${segOrdinal + 1}`];

    // Fact: session project
    allFacts.push({
      subject: sessionId,
      predicate: "codex_session_project",
      object_value: projectName,
      fact_kind: "state",
      assertion_class: "deterministic",
      confidence: 1.0,
      segment_ids: segRef,
    });

    // Fact: working directory
    allFacts.push({
      subject: sessionId,
      predicate: "codex_cwd",
      object_value: cwd,
      fact_kind: "state",
      assertion_class: "deterministic",
      confidence: 1.0,
      segment_ids: segRef,
    });

    // Fact: CLI version
    if (meta?.cli_version) {
      allFacts.push({
        subject: sessionId,
        predicate: "codex_cli_version",
        object_value: meta.cli_version,
        fact_kind: "state",
        assertion_class: "deterministic",
        confidence: 1.0,
        segment_ids: segRef,
      });
    }

    // Model/effort info
    const modelInfo = extractModelInfo(lines);
    if (modelInfo) {
      allFacts.push({
        subject: sessionId,
        predicate: "codex_model",
        object_value: `${modelInfo.model} (effort: ${modelInfo.effort})`,
        fact_kind: "state",
        assertion_class: "deterministic",
        confidence: 1.0,
        segment_ids: segRef,
      });
    }

    // Tool calls -> facts
    const toolCalls = extractToolCalls(lines);
    const shellCommands = extractShellCommands(toolCalls);

    for (const cmd of [...new Set(shellCommands)].slice(0, 30)) {
      allFacts.push({
        subject: sessionId,
        predicate: "ran_command",
        object_value: cmd,
        fact_kind: "event",
        assertion_class: "deterministic",
        confidence: 1.0,
        segment_ids: segRef,
      });
    }

    // Non-shell tool calls
    const otherTools = toolCalls
      .filter((t) => t.name !== "shell_command" && t.name !== "update_plan")
      .map((t) => t.name);
    for (const tool of [...new Set(otherTools)].slice(0, 20)) {
      allFacts.push({
        subject: sessionId,
        predicate: "used_tool",
        object_value: tool,
        fact_kind: "event",
        assertion_class: "deterministic",
        confidence: 1.0,
        segment_ids: segRef,
      });
    }

    // File paths -> entities + facts
    const filePaths = extractFilePaths(lines);
    for (const fp of [...filePaths].slice(0, 50)) {
      allEntities.push({ name: fp, type: "file" as any });
      allFacts.push({
        subject: sessionId,
        predicate: "touched_file",
        object_value: fp,
        fact_kind: "event",
        assertion_class: "deterministic",
        confidence: 0.9,
        segment_ids: segRef,
      });
    }

    // User messages -> segment
    const userMsgs = extractUserMessages(lines);
    segOrdinal++;
    allSegments.push({
      ordinal: segOrdinal,
      section_label: `codex_session:${sessionId.slice(0, 8)}`,
      content: [
        `CWD: ${cwd}`,
        `Model: ${modelInfo?.model || "unknown"}`,
        `Tool calls: ${toolCalls.length}`,
        `Commands: ${shellCommands.length}`,
        `Files: ${filePaths.size}`,
        "",
        "User prompts:",
        ...userMsgs.map((m) => `  > ${m}`),
      ].join("\n"),
      line_start: 1,
      line_end: lines.length,
    });
  }

  // ── History entries without matching session files ──────────────────────
  for (const [sessionId, entries] of sessionPrompts) {
    // Check if we already processed this session
    if (allFacts.some((f) => f.subject === sessionId)) continue;

    segOrdinal++;
    const segRef = [`seg_${segOrdinal}`];

    allEntities.push({ name: sessionId, type: "session" as any });

    for (const entry of entries) {
      allFacts.push({
        subject: sessionId,
        predicate: "codex_prompt",
        object_value: entry.text.slice(0, 500),
        fact_kind: "event",
        assertion_class: "deterministic",
        confidence: 1.0,
        valid_from: new Date(entry.ts * 1000).toISOString(),
        segment_ids: segRef,
      });
    }

    allSegments.push({
      ordinal: segOrdinal,
      section_label: `codex_history:${sessionId.slice(0, 8)}`,
      content: entries.map((e) => `[${new Date(e.ts * 1000).toISOString()}] ${e.text}`).join("\n"),
      line_start: 1,
      line_end: entries.length,
    });
  }

  const firstTs = historyEntries.length > 0
    ? new Date(historyEntries[0].ts * 1000).toISOString()
    : sessionFiles.length > 0 ? undefined : new Date().toISOString();

  const lastTs = historyEntries.length > 0
    ? new Date(historyEntries[historyEntries.length - 1].ts * 1000).toISOString()
    : undefined;

  const episode: Episode = {
    type: "session",
    title: `Codex history: ${sessionsProcessed} sessions, ${historyEntries.length} prompts`,
    start_at: firstTs,
    end_at: lastTs,
    summary: `Parsed ${sessionsProcessed} Codex session files and ${historyEntries.length} history entries. Found ${allEntities.length} entities and ${allFacts.length} facts.`,
  };

  return {
    entities: deduplicateEntities(allEntities),
    facts: allFacts,
    segments: allSegments,
    episode,
    scope_path: "codex:history",
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function collectSessionFiles(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSessionFiles(fullPath, out);
    } else if (entry.name.endsWith(".jsonl")) {
      out.push(fullPath);
    }
  }
}

function deduplicateEntities(entities: Entity[]): Entity[] {
  const seen = new Map<string, Entity>();
  for (const e of entities) {
    const key = `${e.type}:${e.name}`;
    if (!seen.has(key)) {
      seen.set(key, e);
    }
  }
  return [...seen.values()];
}
