/**
 * deterministic.ts — Parse OpsVault incident markdown with zero LLM involvement.
 * Extracts entities, facts, segments, and episode metadata from YAML frontmatter
 * and markdown body structure. All facts get assertion_class='deterministic'
 * and confidence=1.0.
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import { parse as parseYAML } from "yaml";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Entity {
  name: string;
  type: string;
  aliases?: string[];
}

export interface Fact {
  subject: string;
  predicate: string;
  object_value: any;
  fact_kind: string;
  assertion_class: "deterministic";
  confidence: number;
  valid_from?: string;
  valid_to?: string;
  segment_ids: string[];
}

export interface Segment {
  ordinal: number;
  section_label: string;
  content: string;
  line_start: number;
  line_end: number;
}

export interface Episode {
  type: string;
  title: string;
  start_at?: string;
  end_at?: string;
  severity?: string;
  outcome?: string;
  summary?: string;
}

export interface DeterministicResult {
  entities: Entity[];
  facts: Fact[];
  segments: Segment[];
  episode: Episode;
  scope_path: string;
}

// ── Frontmatter Parsing ────────────────────────────────────────────────────────

interface IncidentFrontmatter {
  status?: string;
  opened?: string;
  closed?: string;
  severity?: string;
  devices?: string[];
  services?: string[];
  root_cause?: string;
  fix_summary?: string;
  tags?: string[];
}

function extractFrontmatter(raw: string): { frontmatter: IncidentFrontmatter; bodyStart: number } {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    return { frontmatter: {}, bodyStart: 0 };
  }

  try {
    const parsed = parseYAML(fmMatch[1]) as Record<string, any>;
    return {
      frontmatter: parsed || {},
      bodyStart: fmMatch[0].length,
    };
  } catch {
    return { frontmatter: {}, bodyStart: 0 };
  }
}

// ── Body Parsing ───────────────────────────────────────────────────────────────

/**
 * Extract inline metadata from the markdown body.
 * Handles two formats:
 *   1. Bold markdown: **Status:** closed
 *   2. Plain YAML-like: status: closed
 * Both are common in OpsVault incident notes.
 */
function extractInlineMetadata(body: string): Record<string, string> {
  const meta: Record<string, string> = {};

  // Pattern set 1: Bold markdown format
  const boldPatterns = [
    { key: "status", pattern: /\*\*Status:\*\*\s*(.+)/i },
    { key: "opened", pattern: /\*\*Opened:\*\*\s*(.+)/i },
    { key: "closed", pattern: /\*\*Closed:\*\*\s*(.+)/i },
    { key: "severity", pattern: /\*\*Severity:\*\*\s*(.+)/i },
    { key: "systems", pattern: /\*\*Systems?:\*\*\s*(.+)/i },
    { key: "services", pattern: /\*\*Services?:\*\*\s*(.+)/i },
    { key: "root_cause", pattern: /\*\*Root Cause:\*\*\s*(.+)/i },
    { key: "fix_summary", pattern: /\*\*Fix Summary:\*\*\s*(.+)/i },
    { key: "last_verified", pattern: /\*\*Last Verified:\*\*\s*(.+)/i },
  ];

  for (const { key, pattern } of boldPatterns) {
    const match = body.match(pattern);
    if (match) {
      meta[key] = match[1].trim();
    }
  }

  // Pattern set 2: Plain YAML-like key: value (only in first ~30 lines before headings)
  // These appear in incidents that have a metadata block at the top of the body
  const headerBlock = body.split(/\n##/)[0]; // Text before first heading
  const plainPatterns = [
    { key: "status", pattern: /^status:[ \t]*(.+)/im },
    { key: "opened", pattern: /^opened:[ \t]*(.+)/im },
    { key: "closed", pattern: /^closed:[ \t]*(.+)/im },
    { key: "severity", pattern: /^severity:[ \t]*(.+)/im },
    { key: "systems", pattern: /^systems:[ \t]*(.+)/im },
    { key: "services", pattern: /^services:[ \t]*(.+)/im },
    { key: "root_cause", pattern: /^root_cause:[ \t]*(.+)/im },
    { key: "fix_summary", pattern: /^fix_summary:[ \t]*(.+)/im },
    { key: "last_verified", pattern: /^last_verified:[ \t]*(.+)/im },
  ];

  for (const { key, pattern } of plainPatterns) {
    if (meta[key]) continue; // Bold patterns take precedence
    const match = headerBlock.match(pattern);
    if (match) {
      let value = match[1].trim();
      // Handle YAML-like array syntax: [a, b, c]
      if (value.startsWith("[") && value.endsWith("]")) {
        value = value.slice(1, -1); // Strip brackets, keep as comma-separated
      }
      if (value) meta[key] = value;
    }
  }

  return meta;
}

/**
 * Split body into segments by markdown headings (## or ###).
 * Tracks code fence state to avoid splitting on headings inside code blocks.
 */
function splitSegments(body: string, lineOffset: number): Segment[] {
  const lines = body.split("\n");
  const segments: Segment[] = [];
  let current: { label: string; startLine: number; lines: string[] } | null = null;
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track code fence state
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
    }

    const headingMatch = !inCodeBlock ? line.match(/^(#{2,3})\s+(.+)/) : null;

    if (headingMatch) {
      // Close previous segment
      if (current && current.lines.length > 0) {
        segments.push({
          ordinal: segments.length + 1,
          section_label: current.label,
          content: current.lines.join("\n").trim(),
          line_start: current.startLine + lineOffset,
          line_end: i - 1 + lineOffset,
        });
      }
      current = {
        label: headingMatch[2].trim(),
        startLine: i + 1,
        lines: [],
      };
    } else if (current) {
      current.lines.push(line);
    }
  }

  // Close final segment
  if (current && current.lines.length > 0) {
    segments.push({
      ordinal: segments.length + 1,
      section_label: current.label,
      content: current.lines.join("\n").trim(),
      line_start: current.startLine + lineOffset,
      line_end: lines.length - 1 + lineOffset,
    });
  }

  return segments;
}

// ── Main Extraction ────────────────────────────────────────────────────────────

export async function parseDeterministic(
  incidentDir: string,
): Promise<DeterministicResult> {
  // Find the notes file
  const candidates = ["notes.md", "incident.md"];
  let filePath: string | null = null;
  for (const name of candidates) {
    const p = join(incidentDir, name);
    if (existsSync(p)) {
      filePath = p;
      break;
    }
  }
  if (!filePath) {
    throw new Error(
      `No notes.md or incident.md found in ${incidentDir}`,
    );
  }

  const raw = await readFile(filePath, "utf-8");
  const slug = basename(incidentDir);

  // Parse frontmatter
  const { frontmatter, bodyStart } = extractFrontmatter(raw);
  const body = raw.slice(bodyStart);

  // Parse inline metadata from body
  const inlineMeta = extractInlineMetadata(body);

  // Merge: frontmatter takes precedence, inline fills gaps
  const status = frontmatter.status || inlineMeta.status || "unknown";
  const opened = frontmatter.opened || inlineMeta.opened;
  const closed = frontmatter.closed || inlineMeta.closed;
  const severity = frontmatter.severity || inlineMeta.severity;
  const rootCause = frontmatter.root_cause || inlineMeta.root_cause;
  const fixSummary = frontmatter.fix_summary || inlineMeta.fix_summary;

  // Devices: from frontmatter or inline Systems field
  let devices: string[] = frontmatter.devices || [];
  if (devices.length === 0 && inlineMeta.systems) {
    devices = inlineMeta.systems.split(",").map((s) => s.trim()).filter(Boolean);
  }

  // Services: from frontmatter or inline Services field
  let services: string[] = frontmatter.services || [];
  if (services.length === 0 && inlineMeta.services) {
    services = inlineMeta.services.split(",").map((s) => s.trim()).filter(Boolean);
  }

  // Count frontmatter lines for segment offset
  const fmLines = raw.slice(0, bodyStart).split("\n").length;

  // Build segments
  const segments = splitSegments(body, fmLines);

  // First segment id for frontmatter-derived facts (reference the whole doc)
  const fmSegmentIds = segments.length > 0 ? [`seg_${segments[0].ordinal}`] : ["seg_0"];

  // ── Build Entities ───────────────────────────────────────────────────────
  const entities: Entity[] = [];
  for (const device of devices) {
    entities.push({ name: device, type: "device" });
  }
  for (const service of services) {
    entities.push({ name: service, type: "service" });
  }
  // The incident itself is an entity
  entities.push({ name: slug, type: "incident" });

  // ── Build Facts ──────────────────────────────────────────────────────────
  const facts: Fact[] = [];

  // Status fact
  facts.push({
    subject: slug,
    predicate: "status",
    object_value: status,
    fact_kind: "state",
    assertion_class: "deterministic",
    confidence: 1.0,
    segment_ids: fmSegmentIds,
  });

  // Device had_incident facts
  for (const device of devices) {
    facts.push({
      subject: device,
      predicate: "had_incident",
      object_value: slug,
      fact_kind: "event",
      assertion_class: "deterministic",
      confidence: 1.0,
      valid_from: opened,
      valid_to: closed,
      segment_ids: fmSegmentIds,
    });
  }

  // Service involved_in facts
  for (const service of services) {
    facts.push({
      subject: service,
      predicate: "involved_in",
      object_value: slug,
      fact_kind: "event",
      assertion_class: "deterministic",
      confidence: 1.0,
      valid_from: opened,
      valid_to: closed,
      segment_ids: fmSegmentIds,
    });
  }

  // Root cause fact
  if (rootCause) {
    facts.push({
      subject: slug,
      predicate: "root_cause",
      object_value: rootCause,
      fact_kind: "cause",
      assertion_class: "deterministic",
      confidence: 1.0,
      segment_ids: fmSegmentIds,
    });
  }

  // Fix summary fact
  if (fixSummary) {
    facts.push({
      subject: slug,
      predicate: "fix_summary",
      object_value: fixSummary,
      fact_kind: "remediation",
      assertion_class: "deterministic",
      confidence: 1.0,
      segment_ids: fmSegmentIds,
    });
  }

  // Tags as facts
  if (frontmatter.tags && frontmatter.tags.length > 0) {
    for (const tag of frontmatter.tags) {
      facts.push({
        subject: slug,
        predicate: "tagged",
        object_value: tag,
        fact_kind: "state",
        assertion_class: "deterministic",
        confidence: 1.0,
        segment_ids: fmSegmentIds,
      });
    }
  }

  // ── Build Episode ────────────────────────────────────────────────────────
  // Extract title from first H1 in body (outside code blocks)
  // Strip code fences before searching, and handle BOM
  const bodyNoCode = body.replace(/```[\s\S]*?```/g, "");
  const titleMatch = bodyNoCode.match(/^\uFEFF?#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim().replace(/\u00E2\u20AC[\u201C\u201D\u2122\u2014]/g, "—") : slug;

  // Extract summary from Executive Summary section or first paragraph
  let summary: string | undefined;
  const execSummary = segments.find(
    (s) => s.section_label.toLowerCase().includes("executive summary") ||
           s.section_label.toLowerCase().includes("summary"),
  );
  if (execSummary) {
    // Get the verdict or first meaningful line
    const verdictMatch = execSummary.content.match(/\*\*Verdict:\*\*\s*(.+)/);
    summary = verdictMatch ? verdictMatch[1].trim() : execSummary.content.slice(0, 300);
  }

  const episode: Episode = {
    type: "incident",
    title,
    start_at: opened,
    end_at: closed,
    severity,
    outcome: status === "closed" ? "resolved" : status,
    summary,
  };

  // ── Scope Path ───────────────────────────────────────────────────────────
  const primaryDevice = devices[0] || "unknown";
  const scope_path = `device:${primaryDevice}/incident:${slug}`;

  return {
    entities,
    facts,
    segments,
    episode,
    scope_path,
  };
}
