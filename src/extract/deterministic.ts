/**
 * deterministic.ts — Parse vault incident markdown with zero LLM involvement.
 * Extracts entities, facts, segments, and episode metadata from YAML frontmatter
 * and markdown body structure. All facts get assertion_class='deterministic'
 * and confidence=1.0.
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, basename, relative } from "path";
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
  /**
   * Optional per-fact metadata used by quality-gate validators to make
   * per-fact decisions (e.g. monitoring_alert service/severity). Not
   * persisted as a dedicated column — load.ts reads fields from here when
   * invoking the validator and discards them before INSERT.
   */
  metadata?: Record<string, any>;
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
  source_key?: string;
  incident_label?: string;
  owner_surface?: "device" | "project";
  owner_key?: string;
}

// ── Frontmatter Parsing ────────────────────────────────────────────────────────

interface IncidentFrontmatter {
  type?: string;
  incident_id?: string;
  title?: string;
  status?: string;
  opened?: string;
  closed?: string;
  severity?: string;
  owner_surface?: "device" | "project";
  owner_key?: string;
  systems?: string[] | string;
  devices?: string[];
  hosts?: string[] | string;
  projects?: string[] | string;
  project?: string;
  services?: string[];
  root_cause?: string;
  fix_summary?: string;
  tags?: string[];
}

function normalizeList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  const text = String(value).trim();
  if (!text) return [];
  const unwrapped = text.startsWith("[") && text.endsWith("]")
    ? text.slice(1, -1)
    : text;
  return unwrapped
    .split(/[,;]/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function normalizeStatus(value: unknown): string {
  const aliases: Record<string, string> = {
    investigating: "active",
    mitigated: "active",
    resolved: "closed",
    postmortem: "active",
    done: "closed",
  };
  const raw = String(value || "open").trim().toLowerCase();
  const status = aliases[raw] || raw;
  return ["open", "active", "closed", "archived", "stale"].includes(status)
    ? status
    : "open";
}

function repoRelativeIncidentPath(incidentDir: string): string {
  const vaultRoot = (process.env.BRAINCORE_VAULT_ROOT || "").replace(/\/+$/, "");
  if (vaultRoot && (incidentDir === vaultRoot || incidentDir.startsWith(vaultRoot + "/"))) {
    return relative(vaultRoot, incidentDir).replace(/\\/g, "/");
  }
  const match = incidentDir.match(/(?:^|\/)((?:20_devices|10_projects)\/.+)$/);
  return match ? match[1] : basename(incidentDir);
}

function ownerFromPath(relIncidentPath: string): {
  ownerSurface?: "device" | "project";
  ownerKey?: string;
} {
  const parts = relIncidentPath.split("/");
  if (parts.length >= 4 && parts[0] === "20_devices" && parts[2].toLowerCase() === "incidents") {
    return { ownerSurface: "device", ownerKey: parts[1] };
  }
  if (parts.length >= 4 && parts[0] === "10_projects" && parts[2].toLowerCase() === "incidents") {
    return { ownerSurface: "project", ownerKey: parts[1] };
  }
  return {};
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
 * Both are common in vault incident notes.
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
  const relIncidentPath = repoRelativeIncidentPath(incidentDir);

  // Parse frontmatter
  const { frontmatter, bodyStart } = extractFrontmatter(raw);
  const body = raw.slice(bodyStart);
  const pathOwner = ownerFromPath(relIncidentPath);
  const ownerSurface = frontmatter.owner_surface || pathOwner.ownerSurface;
  const ownerKey = frontmatter.owner_key || pathOwner.ownerKey;
  const incidentLabel = frontmatter.incident_id || slug;
  const sourceKey = relIncidentPath;

  // Parse inline metadata from body
  const inlineMeta = extractInlineMetadata(body);

  // Merge: frontmatter takes precedence, inline fills gaps
  const status = normalizeStatus(frontmatter.status || inlineMeta.status);
  const opened = frontmatter.opened || inlineMeta.opened;
  const closed = frontmatter.closed || inlineMeta.closed;
  const severity = frontmatter.severity || inlineMeta.severity;
  const rootCause = frontmatter.root_cause || inlineMeta.root_cause;
  const fixSummary = frontmatter.fix_summary || inlineMeta.fix_summary;

  // Systems are the canonical host/device list. devices/hosts are legacy-read.
  let systems: string[] = normalizeList(frontmatter.systems);
  if (systems.length === 0) systems = normalizeList(frontmatter.devices);
  if (systems.length === 0) systems = normalizeList(frontmatter.hosts);
  if (systems.length === 0 && inlineMeta.systems) {
    systems = normalizeList(inlineMeta.systems);
  }
  if (systems.length === 0 && ownerSurface === "device" && ownerKey) {
    systems = [ownerKey];
  }

  let projects: string[] = normalizeList(frontmatter.projects || frontmatter.project);
  if (projects.length === 0 && ownerSurface === "project" && ownerKey) {
    projects = [ownerKey];
  }

  // Services: from frontmatter or inline Services field
  let services: string[] = normalizeList(frontmatter.services);
  if (services.length === 0 && inlineMeta.services) {
    services = normalizeList(inlineMeta.services);
  }

  // Count frontmatter lines for segment offset
  const fmLines = raw.slice(0, bodyStart).split("\n").length;

  // Build segments
  const segments = splitSegments(body, fmLines);

  // First segment id for frontmatter-derived facts (reference the whole doc)
  const fmSegmentIds = segments.length > 0 ? [`seg_${segments[0].ordinal}`] : ["seg_0"];

  // ── Build Entities ───────────────────────────────────────────────────────
  const entities: Entity[] = [];
  for (const system of systems) {
    entities.push({ name: system, type: "device" });
  }
  for (const project of projects) {
    entities.push({ name: project, type: "project" });
  }
  for (const service of services) {
    entities.push({ name: service, type: "service" });
  }
  // The incident itself is an entity
  entities.push({ name: incidentLabel, type: "incident", aliases: incidentLabel === slug ? [] : [slug] });

  // ── Build Facts ──────────────────────────────────────────────────────────
  const facts: Fact[] = [];

  // Status fact
  facts.push({
    subject: incidentLabel,
    predicate: "status",
    object_value: status,
    fact_kind: "state",
    assertion_class: "deterministic",
    confidence: 1.0,
    segment_ids: fmSegmentIds,
  });

  // Device had_incident facts
  for (const system of systems) {
    facts.push({
      subject: system,
      predicate: "had_incident",
      object_value: incidentLabel,
      fact_kind: "event",
      assertion_class: "deterministic",
      confidence: 1.0,
      valid_from: opened,
      valid_to: closed,
      segment_ids: fmSegmentIds,
    });
  }

  // Project had_incident facts
  for (const project of projects) {
    facts.push({
      subject: project,
      predicate: "had_incident",
      object_value: incidentLabel,
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
      object_value: incidentLabel,
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
      subject: incidentLabel,
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
      subject: incidentLabel,
      predicate: "fix_summary",
      object_value: fixSummary,
      fact_kind: "remediation",
      assertion_class: "deterministic",
      confidence: 1.0,
      segment_ids: fmSegmentIds,
    });
  }

  // Tags as facts
  const tags = normalizeList(frontmatter.tags);
  if (tags.length > 0) {
    for (const tag of tags) {
      facts.push({
        subject: incidentLabel,
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
  const title = frontmatter.title || (titleMatch ? titleMatch[1].trim().replace(/\u00E2\u20AC[\u201C\u201D\u2122\u2014]/g, "—") : incidentLabel);

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
  const ownerPrefix =
    ownerSurface && ownerKey
      ? `${ownerSurface}:${ownerKey}`
      : systems[0]
        ? `device:${systems[0]}`
        : "owner:unknown";
  const scope_path = `${ownerPrefix}/incident:${incidentLabel}`;

  return {
    entities,
    facts,
    segments,
    episode,
    scope_path,
    source_key: sourceKey,
    incident_label: incidentLabel,
    owner_surface: ownerSurface,
    owner_key: ownerKey,
  };
}
