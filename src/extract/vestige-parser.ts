import { createHash } from "crypto";
import type { DeterministicResult, Entity, Fact, Segment } from "./deterministic";
import { assertUniqueSourceKeys, readJsonOrJsonl, toSafeString, type SourceExtraction } from "./source-export";

interface VestigeRecord {
  id?: unknown;
  content?: unknown;
  nodeType?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  lastAccessed?: unknown;
  nextReview?: unknown;
  source?: unknown;
  tags?: unknown;
  stability?: unknown;
  difficulty?: unknown;
  storageStrength?: unknown;
  retrievalStrength?: unknown;
  retentionStrength?: unknown;
  utilityScore?: unknown;
  timesRetrieved?: unknown;
  timesUseful?: unknown;
  hasEmbedding?: unknown;
  embeddingModel?: unknown;
}

const NODE_TYPE_TO_FACT_KIND: Record<string, string> = {
  decision: "decision",
  preference: "constraint",
  feedback: "constraint",
  gotcha: "lesson",
  learning: "lesson",
  workflow: "state",
  mapping: "state",
  environment: "state",
};

export async function parseVestigeExport(exportPath: string): Promise<SourceExtraction[]> {
  const records = (await readJsonOrJsonl(exportPath)) as VestigeRecord[];
  const items: SourceExtraction[] = [];

  for (const record of records) {
    const content = toSafeString(record.content);
    if (!content) continue;

    const rawId = toSafeString(record.id) || sha256(content).slice(0, 16);
    const sourceKey = `vestige_memory:${safeKeyPart(rawId)}`;
    const nodeType = (toSafeString(record.nodeType) || "memory").toLowerCase();
    const tags = normalizeStringList(record.tags);
    const source = toSafeString(record.source);
    const sourceContent = JSON.stringify(record, null, 2);
    const segment: Segment = {
      ordinal: 1,
      section_label: `${nodeType}: ${rawId}`.slice(0, 100),
      content: buildSegmentContent(record, content, nodeType, tags),
      line_start: 1,
      line_end: content.split(/\r?\n/).length,
    };
    const segRef = ["seg_1"];
    const entities: Entity[] = [
      { name: sourceKey, type: "config_item" as any },
    ];
    if (source) entities.push({ name: source, type: "config_item" as any });

    const facts: Fact[] = [
      fact(sourceKey, "vestige_node_type", nodeType, "state", "deterministic", segRef),
      fact(sourceKey, "vestige_memory_content", content.slice(0, 4000), factKindForNode(nodeType), "human_curated", segRef),
    ];

    addOptionalFact(facts, sourceKey, "vestige_source", source, segRef);
    addOptionalFact(facts, sourceKey, "vestige_created_at", toSafeString(record.createdAt), segRef);
    addOptionalFact(facts, sourceKey, "vestige_updated_at", toSafeString(record.updatedAt), segRef);
    addOptionalFact(facts, sourceKey, "vestige_last_accessed", toSafeString(record.lastAccessed), segRef);
    addOptionalFact(facts, sourceKey, "vestige_next_review", toSafeString(record.nextReview), segRef);
    addOptionalFact(facts, sourceKey, "vestige_embedding_model", toSafeString(record.embeddingModel), segRef);

    for (const tag of tags) {
      facts.push(fact(sourceKey, "tagged", tag, "state", "deterministic", segRef));
    }

    for (const [predicate, value] of Object.entries({
      vestige_stability: record.stability,
      vestige_difficulty: record.difficulty,
      vestige_storage_strength: record.storageStrength,
      vestige_retrieval_strength: record.retrievalStrength,
      vestige_retention_strength: record.retentionStrength,
      vestige_utility_score: record.utilityScore,
      vestige_times_retrieved: record.timesRetrieved,
      vestige_times_useful: record.timesUseful,
      vestige_has_embedding: record.hasEmbedding,
    })) {
      if (value !== undefined && value !== null && value !== "") {
        facts.push(fact(sourceKey, predicate, value, "state", "deterministic", segRef));
      }
    }

    const result: DeterministicResult = {
      entities: deduplicateEntities(entities),
      facts,
      segments: [segment],
      episode: {
        type: "session",
        title: `Vestige memory import: ${rawId}`,
        start_at: toSafeString(record.createdAt),
        summary: `Imported one Vestige memory with nodeType=${nodeType}.`,
      },
      scope_path: `assistant:vestige/${nodeType}`,
      source_key: sourceKey,
    };

    items.push({
      sourceKey,
      sourceType: "vestige_memory",
      originalPath: `${exportPath}#${rawId}`,
      sourceContent,
      result,
    });
  }

  assertUniqueSourceKeys(items);
  return items;
}

function buildSegmentContent(record: VestigeRecord, content: string, nodeType: string, tags: string[]): string {
  return [
    `Source: Vestige`,
    `Node type: ${nodeType}`,
    `ID: ${toSafeString(record.id) || "unknown"}`,
    `Created: ${toSafeString(record.createdAt) || "unknown"}`,
    `Updated: ${toSafeString(record.updatedAt) || "unknown"}`,
    `Tags: ${tags.join(", ") || "none"}`,
    `Embedding model: ${toSafeString(record.embeddingModel) || "none"}`,
    "",
    content,
  ].join("\n").slice(0, 8000);
}

function fact(
  subject: string,
  predicate: string,
  objectValue: unknown,
  factKind: string,
  assertionClass: "deterministic" | "human_curated",
  segmentIds: string[],
): Fact {
  return {
    subject,
    predicate,
    object_value: objectValue,
    fact_kind: factKind,
    assertion_class: assertionClass as any,
    confidence: assertionClass === "deterministic" ? 1.0 : 0.85,
    segment_ids: segmentIds,
  };
}

function addOptionalFact(
  facts: Fact[],
  subject: string,
  predicate: string,
  value: string | undefined,
  segmentIds: string[],
): void {
  if (value) facts.push(fact(subject, predicate, value, "state", "deterministic", segmentIds));
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => toSafeString(item)).filter((item): item is string => Boolean(item));
}

function factKindForNode(nodeType: string): string {
  return NODE_TYPE_TO_FACT_KIND[nodeType] || "state";
}

function safeKeyPart(value: string): string {
  return value.trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_.:-]/g, "_");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function deduplicateEntities(entities: Entity[]): Entity[] {
  const seen = new Map<string, Entity>();
  for (const entity of entities) {
    const key = `${entity.type}:${entity.name}`;
    if (!seen.has(key)) seen.set(key, entity);
  }
  return [...seen.values()];
}
