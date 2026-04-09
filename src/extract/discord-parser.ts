/**
 * discord-parser.ts — Parse Discord digest micro_summaries from SQLite.
 *
 * The discord_digest service already produces AI-summarized micro_summaries
 * with tagged items: [INSIGHT], [BREAKING], [RELEASE], [DEBATE].
 * Each summary becomes a segment. Tagged items become facts.
 *
 * Dedup: summary ID + channel name as source_key prevents re-ingestion.
 * Project linking: channel names checked against project_service_map.
 *
 * Returns DeterministicResult compatible with load.ts.
 */

import Database from "bun:sqlite";
import type { DeterministicResult, Entity, Fact, Segment, Episode } from "./deterministic";

const DISCORD_DB_PATH = process.env.DISCORD_DB_PATH
  || "./data/discord-digest.db";

/**
 * Sanitize text for PostgreSQL JSON storage.
 * Removes lone surrogates (\uD800-\uDFFF) and other problematic Unicode
 * that causes "Unicode low surrogate must follow a high surrogate" errors.
 */
function sanitizeForJson(text: string): string {
  // Remove lone surrogates (unpaired high/low surrogates)
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\uD800-\uDFFF]/g, "");
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface MicroSummaryRow {
  id: string;
  channelId: string;
  channelName: string;
  windowStart: number;
  windowEnd: number;
  messageCount: number;
  model: string;
  summary: string;
  createdAt: string;
}

interface TaggedItem {
  tag: string;
  title: string;
  detail: string;
}

// ── Tag -> fact_kind mapping ───────────────────────────────────────────────────

const TAG_TO_FACT_KIND: Record<string, string> = {
  INSIGHT: "lesson",
  BREAKING: "event",
  RELEASE: "event",
  DEBATE: "lesson",
  ACTION: "decision",
  DECISION: "decision",
};

// ── Channel -> project name hints ──────────────────────────────────────────────
// These map well-known Discord channel names to project service names.
// The project-resolver uses project_service_map in Postgres for authoritative
// resolution; this gives an initial hint for scope_path generation.

const CHANNEL_PROJECT_HINTS: Record<string, string> = {
  "security": "pai",
  "architecture": "pai",
  "skills": "pai",
  "dev-chat": "pai",
  "research": "pai",
  "general": "pai",
  "announcements": "pai",
};

// ── Parsing ────────────────────────────────────────────────────────────────────

/**
 * Parse tagged items from a micro_summary markdown text.
 * Format: - **[TAG] Title** — Detail text
 * Also handles: - **[TAG] Title** — Detail\n  continuation
 */
function parseTaggedItems(summary: string): TaggedItem[] {
  const items: TaggedItem[] = [];
  // Match: **[TAG] Title** — Detail
  const pattern = /\*\*\[(\w+)\]\s+(.+?)\*\*\s*[—–-]\s*(.+?)(?=\n-\s*\*\*\[|\n\n|$)/gs;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(summary)) !== null) {
    const tag = match[1].toUpperCase();
    const title = match[2].trim();
    // Clean up detail: collapse newlines and trim
    const detail = match[3].replace(/\n\s*/g, " ").trim();
    items.push({ tag, title, detail });
  }

  return items;
}

/**
 * Convert epoch milliseconds to ISO string.
 */
function epochMsToISO(ms: number): string {
  return new Date(ms).toISOString();
}

// ── Main Parser ────────────────────────────────────────────────────────────────

export interface DiscordParseOptions {
  /** Only parse summaries created after this ISO timestamp (for incremental) */
  since?: string;
  /** Max summaries to process (default: all) */
  limit?: number;
  /** Path to the SQLite database */
  dbPath?: string;
}

/**
 * Parse Discord micro_summaries into a DeterministicResult.
 * Opens the SQLite DB read-only, queries micro_summaries joined with channels,
 * and extracts facts from tagged items.
 */
export function parseDiscordSummaries(
  opts: DiscordParseOptions = {},
): DeterministicResult {
  const dbPath = opts.dbPath || DISCORD_DB_PATH;
  const db = new Database(dbPath, { readonly: true });

  try {
    // Build query with optional since filter
    let query = `
      SELECT ms.id, ms.channelId, c.name as channelName,
             ms.windowStart, ms.windowEnd, ms.messageCount,
             ms.model, ms.summary, ms.createdAt
      FROM micro_summaries ms
      JOIN channels c ON c.id = ms.channelId
    `;
    const params: any[] = [];

    if (opts.since) {
      query += ` WHERE ms.createdAt > ?`;
      params.push(opts.since);
    }

    query += ` ORDER BY ms.windowStart ASC`;

    if (opts.limit) {
      query += ` LIMIT ?`;
      params.push(opts.limit);
    }

    const stmt = db.prepare(query);
    const rows = stmt.all(...params) as MicroSummaryRow[];

    const allEntities: Entity[] = [];
    const allFacts: Fact[] = [];
    const allSegments: Segment[] = [];

    // Track unique channels and stats
    const channelsSeen = new Set<string>();
    let totalTaggedItems = 0;
    let segOrdinal = 0;

    for (const row of rows) {
      segOrdinal++;
      const segRef = [`seg_${segOrdinal}`];
      const channelKey = row.channelName.toLowerCase().replace(/[^a-z0-9-]/g, "");

      // Track channel entity
      if (!channelsSeen.has(row.channelName)) {
        channelsSeen.add(row.channelName);
        allEntities.push({
          name: `discord:${row.channelName}`,
          type: "service" as any,
        });
      }

      // The source_key for dedup: summary ID + channel
      const sourceKey = `discord:${row.id}:${row.channelId}`;

      // Parse tagged items from the summary
      const taggedItems = parseTaggedItems(row.summary);
      totalTaggedItems += taggedItems.length;

      // Window timestamps
      const windowStartISO = epochMsToISO(row.windowStart);
      const windowEndISO = epochMsToISO(row.windowEnd);

      // Each tagged item becomes a fact
      for (const item of taggedItems) {
        const factKind = TAG_TO_FACT_KIND[item.tag] || "state";
        const predicate = `discord_${item.tag.toLowerCase()}`;

        allFacts.push({
          subject: `discord:${row.channelName}`,
          predicate,
          object_value: sanitizeForJson(`${item.title}: ${item.detail}`),
          fact_kind: factKind as any,
          assertion_class: "deterministic",
          confidence: 0.85,
          valid_from: windowStartISO,
          valid_to: windowEndISO,
          segment_ids: segRef,
        });
      }

      // If no tagged items, still create a summary fact
      if (taggedItems.length === 0 && row.summary.trim().length > 20) {
        allFacts.push({
          subject: `discord:${row.channelName}`,
          predicate: "discord_summary",
          object_value: sanitizeForJson(row.summary.slice(0, 500)),
          fact_kind: "state",
          assertion_class: "deterministic",
          confidence: 0.7,
          valid_from: windowStartISO,
          valid_to: windowEndISO,
          segment_ids: segRef,
        });
      }

      // Build segment from the summary content
      const segmentContent = sanitizeForJson([
        `Channel: ${row.channelName}`,
        `Window: ${windowStartISO} to ${windowEndISO}`,
        `Messages: ${row.messageCount}`,
        `Model: ${row.model}`,
        "",
        row.summary,
      ].join("\n"));

      allSegments.push({
        ordinal: segOrdinal,
        section_label: `${row.channelName} [${windowStartISO.split("T")[0]}]`,
        content: segmentContent.slice(0, 3000),
        line_start: 1,
        line_end: segmentContent.split("\n").length,
      });
    }

    // Compute date range
    const firstRow = rows[0];
    const lastRow = rows[rows.length - 1];
    const startAt = firstRow ? epochMsToISO(firstRow.windowStart) : undefined;
    const endAt = lastRow ? epochMsToISO(lastRow.windowEnd) : undefined;

    const episode: Episode = {
      type: "session",
      title: `Discord digest: ${rows.length} summaries across ${channelsSeen.size} channels`,
      start_at: startAt,
      end_at: endAt,
      summary: `Parsed ${rows.length} micro_summaries from Discord digest. ` +
        `${totalTaggedItems} tagged items extracted across ${channelsSeen.size} channels. ` +
        `Tags: INSIGHT, BREAKING, RELEASE, DEBATE.`,
    };

    return {
      entities: deduplicateEntities(allEntities),
      facts: allFacts,
      segments: allSegments,
      episode,
      scope_path: "discord:digest",
    };
  } finally {
    db.close();
  }
}

/**
 * Get the most recent createdAt timestamp from previously ingested Discord summaries.
 * Used for incremental scanning.
 */
export function getLatestDiscordTimestamp(dbPath?: string): string | null {
  const path = dbPath || DISCORD_DB_PATH;
  const db = new Database(path, { readonly: true });
  try {
    const row = db.prepare("SELECT MAX(createdAt) as latest FROM micro_summaries").get() as any;
    return row?.latest || null;
  } finally {
    db.close();
  }
}

/**
 * Count micro_summaries optionally filtered by since timestamp.
 */
export function countDiscordSummaries(since?: string, dbPath?: string): number {
  const path = dbPath || DISCORD_DB_PATH;
  const db = new Database(path, { readonly: true });
  try {
    if (since) {
      const row = db.prepare("SELECT COUNT(*) as cnt FROM micro_summaries WHERE createdAt > ?").get(since) as any;
      return row?.cnt || 0;
    }
    const row = db.prepare("SELECT COUNT(*) as cnt FROM micro_summaries").get() as any;
    return row?.cnt || 0;
  } finally {
    db.close();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

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
