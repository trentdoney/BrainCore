/**
 * telegram-parser.ts — Poll Telegram Bot API getUpdates and extract facts.
 * 
 * Uses its own offset file to avoid
 * consuming each other's updates. Persists messages to JSONL history
 * and extracts substantial messages as human_curated facts.
 *
 * Deduplicates by message_id. Filters out short/trivial messages.
 */

import { readFile, writeFile, appendFile } from "fs/promises";
import { existsSync } from "fs";
import { config } from "../config";
import type { DeterministicResult, Entity, Fact, Segment, Episode } from "./deterministic";

const DATA_DIR = "./data";
const OFFSET_FILE = `${DATA_DIR}/telegram-offset.json`;
const HISTORY_FILE = `${DATA_DIR}/telegram-history.jsonl`;

// ── Offset Management ──────────────────────────────────────────────────────────

interface OffsetState {
  offset: number;
  updatedAt: string;
}

async function readOffset(): Promise<number> {
  if (!existsSync(OFFSET_FILE)) return 0;
  try {
    const raw = await readFile(OFFSET_FILE, "utf-8");
    const state: OffsetState = JSON.parse(raw);
    return state.offset;
  } catch {
    return 0;
  }
}

async function writeOffset(offset: number): Promise<void> {
  const state: OffsetState = {
    offset,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(OFFSET_FILE, JSON.stringify(state, null, 2) + "\n");
}

// ── History Dedup ──────────────────────────────────────────────────────────────

async function loadSeenMessageIds(): Promise<Set<number>> {
  const seen = new Set<number>();
  if (!existsSync(HISTORY_FILE)) return seen;
  try {
    const raw = await readFile(HISTORY_FILE, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.message_id) seen.add(msg.message_id);
      } catch {}
    }
  } catch {}
  return seen;
}

// ── Message Filtering ──────────────────────────────────────────────────────────

const TRIVIAL_PATTERNS = [
  /^(ok|okay|yes|no|yep|nope|thanks|thx|ty|sure|k|kk|lol|lmao|haha|hmm|ah|oh|nice|cool|great|done|got it|np)$/i,
  /^[\p{Emoji}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Emoji_Component}\s]+$/u,
];

function isSubstantial(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  // Too short
  if (trimmed.length < 20) return false;
  // Trivial patterns
  for (const pattern of TRIVIAL_PATTERNS) {
    if (pattern.test(trimmed)) return false;
  }
  return true;
}

// ── Telegram API ───────────────────────────────────────────────────────────────

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string; title?: string };
  date: number;
  text?: string;
  reply_to_message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface GetUpdatesResponse {
  ok: boolean;
  result: TelegramUpdate[];
}

async function pollUpdates(offset: number, limit = 100): Promise<TelegramUpdate[]> {
  const token = config.telegram.botToken;
  if (!token) throw new Error("PAI_TELEGRAM_BOT_TOKEN not set");

  const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&limit=${limit}&timeout=0`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Telegram API error: ${res.status} ${await res.text()}`);
  }
  const data: GetUpdatesResponse = await res.json();
  if (!data.ok) {
    throw new Error("Telegram getUpdates returned ok=false");
  }
  return data.result;
}

// ── Persistence ────────────────────────────────────────────────────────────────

interface HistoryEntry {
  message_id: number;
  update_id: number;
  from_user: string;
  from_id: number;
  chat_id: number;
  chat_type: string;
  date: string;
  text: string;
  is_reply: boolean;
  reply_to_message_id?: number;
}

async function appendHistory(entries: HistoryEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await appendFile(HISTORY_FILE, lines);
}

// ── Main Parser ────────────────────────────────────────────────────────────────

export interface TelegramPollResult {
  updatesProcessed: number;
  messagesStored: number;
  substantialMessages: number;
  newOffset: number;
}

/**
 * Poll Telegram for new messages, persist to JSONL, and return
 * DeterministicResult for substantial messages suitable for fact extraction.
 *
 * @param dryRun - if true, don't persist offset or history
 */
export async function parseTelegramChat(
  dryRun = false,
): Promise<{ result: DeterministicResult; stats: TelegramPollResult }> {
  const currentOffset = await readOffset();
  console.log(`  Current offset: ${currentOffset}`);

  const updates = await pollUpdates(currentOffset);
  console.log(`  Updates received: ${updates.length}`);

  const seenIds = await loadSeenMessageIds();
  const newEntries: HistoryEntry[] = [];
  const substantialTexts: { entry: HistoryEntry; text: string }[] = [];
  let maxUpdateId = currentOffset;

  for (const update of updates) {
    const msg = update.message || update.edited_message;
    if (!msg) continue;

    // Track max for offset advancement
    if (update.update_id >= maxUpdateId) {
      maxUpdateId = update.update_id + 1;
    }

    // Skip if already seen
    if (seenIds.has(msg.message_id)) continue;

    // Skip bot's own messages
    if (msg.from?.is_bot) continue;

    const text = msg.text || "";
    const fromName = [msg.from?.first_name, msg.from?.last_name]
      .filter(Boolean)
      .join(" ") || "Unknown";

    const entry: HistoryEntry = {
      message_id: msg.message_id,
      update_id: update.update_id,
      from_user: fromName,
      from_id: msg.from?.id || 0,
      chat_id: msg.chat.id,
      chat_type: msg.chat.type,
      date: new Date(msg.date * 1000).toISOString(),
      text,
      is_reply: !!msg.reply_to_message,
      reply_to_message_id: msg.reply_to_message?.message_id,
    };

    newEntries.push(entry);

    if (isSubstantial(text)) {
      substantialTexts.push({ entry, text });
    }
  }

  // Persist
  if (!dryRun && newEntries.length > 0) {
    await appendHistory(newEntries);
    await writeOffset(maxUpdateId);
  }

  // Build DeterministicResult from substantial messages
  const entities: Entity[] = [];
  const facts: Fact[] = [];
  const segments: Segment[] = [];
  const seenUsers = new Set<string>();

  let segOrdinal = 0;

  for (const { entry, text } of substantialTexts) {
    segOrdinal++;
    const segKey = `seg_${segOrdinal}`;

    // Add user entity (dedup)
    const userName = entry.from_user.toLowerCase().replace(/\s+/g, "_");
    if (!seenUsers.has(userName)) {
      seenUsers.add(userName);
      entities.push({
        name: userName,
        type: "session", // closest available type for person/user
      });
    }

    // Add segment
    segments.push({
      ordinal: segOrdinal,
      section_label: `${entry.from_user} @ ${entry.date}`,
      content: text.slice(0, 2000),
      line_start: 1,
      line_end: text.split("\n").length,
    });

    // Create fact: the message content as a human-curated assertion
    facts.push({
      subject: userName,
      predicate: "stated",
      object_value: text.slice(0, 1000),
      fact_kind: "state",
      assertion_class: "deterministic",
      confidence: 1.0,
      valid_from: entry.date,
      segment_ids: [segKey],
    });

    // Extract any referenced entities from message text
    const deviceRefs = extractDeviceRefs(text);
    for (const device of deviceRefs) {
      if (!entities.find((e) => e.name === device && e.type === "device")) {
        entities.push({ name: device, type: "device" });
      }
      facts.push({
        subject: userName,
        predicate: "mentioned_device",
        object_value: device,
        fact_kind: "state",
        assertion_class: "deterministic",
        confidence: 0.9,
        valid_from: entry.date,
        segment_ids: [segKey],
      });
    }

    const serviceRefs = extractServiceRefs(text);
    for (const service of serviceRefs) {
      if (!entities.find((e) => e.name === service && e.type === "service")) {
        entities.push({ name: service, type: "service" });
      }
      facts.push({
        subject: userName,
        predicate: "mentioned_service",
        object_value: service,
        fact_kind: "state",
        assertion_class: "deterministic",
        confidence: 0.9,
        valid_from: entry.date,
        segment_ids: [segKey],
      });
    }

    // Check for decision/directive patterns
    if (/\b(always|never|must|should|don't|do not|make sure|ensure)\b/i.test(text)) {
      facts.push({
        subject: "system",
        predicate: "directive",
        object_value: text.slice(0, 500),
        fact_kind: "constraint",
        assertion_class: "deterministic",
        confidence: 0.85,
        valid_from: entry.date,
        segment_ids: [segKey],
      });
    }
  }

  const episode: Episode = {
    type: "session",
    title: `Telegram chat poll: ${substantialTexts.length} substantial messages`,
    start_at: substantialTexts.length > 0
      ? substantialTexts[0].entry.date
      : new Date().toISOString(),
    end_at: substantialTexts.length > 0
      ? substantialTexts[substantialTexts.length - 1].entry.date
      : new Date().toISOString(),
    summary: `Polled ${updates.length} updates, stored ${newEntries.length} messages, extracted ${substantialTexts.length} substantial messages with ${facts.length} facts.`,
  };

  const result: DeterministicResult = {
    entities,
    facts,
    segments,
    episode,
    scope_path: "telegram:chat/pai",
  };

  const stats: TelegramPollResult = {
    updatesProcessed: updates.length,
    messagesStored: newEntries.length,
    substantialMessages: substantialTexts.length,
    newOffset: maxUpdateId,
  };

  return { result, stats };
}

// ── Entity Extraction Helpers ──────────────────────────────────────────────────

function extractDeviceRefs(text: string): string[] {
  const devices: string[] = [];
  const seen = new Set<string>();
  const devices = (process.env.BRAINCORE_KNOWN_DEVICES || "server-a,server-b,workstation").split(",");
  const pattern = new RegExp("\\b(" + devices.join("|") + ")\\b", "gi");
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1].toLowerCase().replace(/\s+/g, "_");
    if (!seen.has(name)) {
      seen.add(name);
      devices.push(name);
    }
  }
  return devices;
}

function extractServiceRefs(text: string): string[] {
  const services: string[] = [];
  const seen = new Set<string>();
  const pattern = /\b(docker|nginx|postgresql|postgres|redis|vllm|braincore|grafana|loki|prometheus|telegram)\b/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1].toLowerCase();
    if (!seen.has(name)) {
      seen.add(name);
      services.push(name);
    }
  }
  return services;
}
