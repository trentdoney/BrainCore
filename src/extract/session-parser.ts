/**
 * session-parser.ts — Parse Claude Code JSONL session files.
 * Extracts file paths, commands run, decisions made, and errors.
 * All facts tagged assertion_class='deterministic' (from logs).
 */

import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, basename, dirname } from "path";
import { createHash } from "crypto";
import type { DeterministicResult, Entity, Fact, Segment, Episode } from "./deterministic";

interface SessionMessage {
  type?: string;
  role?: string;
  content?: any;
  tool_name?: string;
  tool_input?: any;
  tool_result?: any;
  timestamp?: string;
}

/**
 * Parse a Claude Code JSONL session file into a DeterministicResult.
 * Session files live in ~/.claude/projects/<project-hash>/sessions/
 */
export async function parseClaudeSession(
  sessionPath: string,
): Promise<DeterministicResult> {
  const raw = await readFile(sessionPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());

  const messages: SessionMessage[] = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  const sessionId = basename(sessionPath, ".jsonl");
  const projectDir = dirname(dirname(sessionPath));
  const projectName = basename(projectDir);

  const filePaths = new Set<string>();
  const commandsRun: string[] = [];
  const decisions: string[] = [];
  const errors: string[] = [];
  const toolCalls: Array<{ tool: string; input: string }> = [];

  for (const msg of messages) {
    if (msg.type === "tool_use" || msg.tool_name) {
      const toolName = msg.tool_name || "";
      const input = msg.tool_input || msg.content || {};

      toolCalls.push({
        tool: toolName,
        input: typeof input === "string" ? input : JSON.stringify(input).slice(0, 200),
      });

      if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
        const filePath = typeof input === "object" ? input.file_path || input.path : "";
        if (filePath) filePaths.add(filePath);
      }

      if (toolName === "Bash") {
        const cmd = typeof input === "object" ? input.command : String(input);
        if (cmd) commandsRun.push(cmd.slice(0, 300));
      }
    }

    if (msg.role === "assistant" && typeof msg.content === "string") {
      const content = msg.content;
      const decisionPatterns = [
        /(?:I'll|I will|Let me|Going to)\s+(.{20,100})/gi,
        /(?:Decision|Approach|Strategy):\s*(.{20,200})/gi,
      ];
      for (const pattern of decisionPatterns) {
        const match = content.match(pattern);
        if (match) decisions.push(match[1]?.trim() || match[0].trim());
      }
    }

    if (msg.type === "tool_result" || msg.tool_result) {
      const result = msg.tool_result || msg.content;
      const resultStr = typeof result === "string" ? result : JSON.stringify(result || "");
      if (
        resultStr.includes("Error") ||
        resultStr.includes("FAILED") ||
        resultStr.includes("error:") ||
        resultStr.includes("Exit code")
      ) {
        errors.push(resultStr.slice(0, 300));
      }
    }
  }

  const entities: Entity[] = [
    { name: sessionId, type: "session" as any },
  ];

  for (const fp of filePaths) {
    entities.push({ name: fp, type: "file" as any });
  }

  const facts: Fact[] = [];
  const segRef = ["seg_1"];

  facts.push({
    subject: sessionId,
    predicate: "session_project",
    object_value: projectName,
    fact_kind: "state",
    assertion_class: "deterministic",
    confidence: 1.0,
    segment_ids: segRef,
  });

  for (const fp of filePaths) {
    facts.push({
      subject: sessionId,
      predicate: "touched_file",
      object_value: fp,
      fact_kind: "event",
      assertion_class: "deterministic",
      confidence: 1.0,
      segment_ids: segRef,
    });
  }

  const uniqueCommands = [...new Set(commandsRun)].slice(0, 20);
  for (const cmd of uniqueCommands) {
    facts.push({
      subject: sessionId,
      predicate: "ran_command",
      object_value: cmd,
      fact_kind: "event",
      assertion_class: "deterministic",
      confidence: 1.0,
      segment_ids: segRef,
    });
  }

  for (const err of errors.slice(0, 10)) {
    facts.push({
      subject: sessionId,
      predicate: "encountered_error",
      object_value: err,
      fact_kind: "event",
      assertion_class: "deterministic",
      confidence: 1.0,
      segment_ids: segRef,
    });
  }

  for (const dec of decisions.slice(0, 10)) {
    facts.push({
      subject: sessionId,
      predicate: "decision_made",
      object_value: dec,
      fact_kind: "decision",
      assertion_class: "deterministic",
      confidence: 0.8,
      segment_ids: segRef,
    });
  }

  const segments: Segment[] = [];
  let segOrdinal = 0;
  let currentContent: string[] = [];
  let currentLabel = "session_start";
  let lineNum = 0;

  for (const msg of messages) {
    lineNum++;
    const content = typeof msg.content === "string"
      ? msg.content.slice(0, 500)
      : JSON.stringify(msg.content || "").slice(0, 500);

    if (msg.role === "user" || msg.role === "human") {
      if (currentContent.length > 0) {
        segOrdinal++;
        segments.push({
          ordinal: segOrdinal,
          section_label: currentLabel,
          content: currentContent.join("\n"),
          line_start: Math.max(1, lineNum - currentContent.length),
          line_end: lineNum - 1,
        });
        currentContent = [];
      }
      currentLabel = `turn_${segOrdinal + 1}`;
    }

    currentContent.push(`[${msg.role || msg.type || "unknown"}] ${content}`);
  }

  if (currentContent.length > 0) {
    segOrdinal++;
    segments.push({
      ordinal: segOrdinal,
      section_label: currentLabel,
      content: currentContent.join("\n"),
      line_start: Math.max(1, lineNum - currentContent.length),
      line_end: lineNum,
    });
  }

  const firstTs = messages.find((m) => m.timestamp)?.timestamp;
  const lastTs = [...messages].reverse().find((m) => m.timestamp)?.timestamp;

  const episode: Episode = {
    type: "session",
    title: `Claude session: ${projectName} (${sessionId.slice(0, 8)})`,
    start_at: firstTs,
    end_at: lastTs,
    summary: `Session with ${messages.length} messages, ${filePaths.size} files, ${commandsRun.length} commands, ${errors.length} errors.`,
  };

  const scope_path = `project:${projectName}/session:${sessionId}`;

  return {
    entities,
    facts,
    segments,
    episode,
    scope_path,
  };
}
