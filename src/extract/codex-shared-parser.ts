/**
 * codex-shared-parser.ts — Parse CODEX_SHARED memory structure.
 *
 * Sources:
 *   1. _index.json — Main index with domains[] and documents[]
 *   2. _domains/<domain>/<slug>.md — Individual memory documents (YAML frontmatter + markdown)
 *   3. instances/<session-id>.json — Session instance metadata with cwd, git_root, domain_snapshot
 *
 * Document kinds: decision, workflow, mapping, environment, preference, gotcha
 *
 * Extracts:
 *   - Each document -> facts tagged assertion_class='human_curated' (agent-curated, high trust)
 *   - Entities from document metadata (paths -> file entities, entities[] -> named entities)
 *   - Instance data -> project resolution via cwd/git_root
 *   - Domain grouping -> scope_path resolution
 *
 * Returns DeterministicResult compatible with load.ts.
 */

import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import { parse as parseYAML } from "yaml";
import type { DeterministicResult, Entity, Fact, Segment, Episode } from "./deterministic";

const CODEX_SHARED_DIR = process.env.BRAINCORE_CODEX_SHARED_DIR || "./data/codex-shared";

function emptyCodexSharedResult(reason: string): DeterministicResult {
  return {
    entities: [],
    facts: [],
    segments: [],
    episode: {
      type: "session",
      title: "CODEX_SHARED scan: skipped (directory not available)",
      summary: reason,
    },
    scope_path: "codex:shared",
  };
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface IndexFile {
  schema_version: number;
  generated_at: string;
  domains: DomainSummary[];
  documents: DocumentEntry[];
}

interface DomainSummary {
  domain: string;
  count: number;
  latest_updated_at: string;
}

interface DocumentEntry {
  id: string;
  domain: string;
  kind: string;
  title: string;
  summary: string;
  tags: string[];
  keywords: string[];
  paths: string[];
  entities: string[];
  updated_at: string;
  rel_path: string;
  fingerprint: string;
  confidence: number;
}

interface InstanceData {
  session_id: string;
  cwd: string;
  git_root?: string;
  domain_snapshot: string[];
  loaded_memory_ids: string[];
  last_loaded_at: string | null;
  last_ingested_turn_id: string;
}

interface DomainDocFrontmatter {
  id?: string;
  domain?: string;
  kind?: string;
  title?: string;
  summary?: string;
  tags?: string[];
  keywords?: string[];
  paths?: string[];
  entities?: string[];
  source_agent?: string;
  source_session_id?: string;
  source_turn_id?: string;
  source_cwd?: string;
  created_at?: string;
  updated_at?: string;
  confidence?: number;
  fingerprint?: string;
}

// ── Kind -> fact_kind mapping ──────────────────────────────────────────────────

const KIND_TO_FACT_KIND: Record<string, string> = {
  decision: "decision",
  workflow: "state",
  mapping: "state",
  environment: "state",
  preference: "constraint",
  gotcha: "lesson",
};

// ── Main Parser ────────────────────────────────────────────────────────────────

/**
 * Parse CODEX_SHARED directory structure.
 * Reads _index.json for the document catalog, then parses each domain document
 * for rich frontmatter + content. Also reads instances/ for session context.
 */
export async function parseCodexShared(
  sharedDir?: string,
): Promise<DeterministicResult> {
  const dir = sharedDir || CODEX_SHARED_DIR;

  if (!dir || !existsSync(dir)) {
    const msg = `CODEX_SHARED directory not found: ${dir || "(unset)"}`;
    console.log(`  [codex-shared-parser] Skipping — ${msg}`);
    return emptyCodexSharedResult(msg);
  }

  const indexPath = join(dir, "_index.json");

  if (!existsSync(indexPath)) {
    const msg = `CODEX_SHARED _index.json not found: ${indexPath}`;
    console.log(`  [codex-shared-parser] Skipping — ${msg}`);
    return emptyCodexSharedResult(msg);
  }

  // Load the index
  const indexRaw = await readFile(indexPath, "utf-8");
  const index: IndexFile = JSON.parse(indexRaw);

  const allEntities: Entity[] = [];
  const allFacts: Fact[] = [];
  const allSegments: Segment[] = [];
  let segOrdinal = 0;

  // ── Load instance data for project resolution ──────────────────────────
  const instanceMap = new Map<string, InstanceData>();
  const instancesDir = join(dir, "instances");
  if (existsSync(instancesDir)) {
    const instanceFiles = await readdir(instancesDir);
    for (const f of instanceFiles.filter((f) => f.endsWith(".json"))) {
      try {
        const raw = await readFile(join(instancesDir, f), "utf-8");
        const inst: InstanceData = JSON.parse(raw);
        if (inst.session_id) {
          instanceMap.set(inst.session_id, inst);
        }
      } catch {}
    }
  }

  // ── Process each document from the index ───────────────────────────────
  for (const doc of index.documents) {
    segOrdinal++;
    const segRef = [`seg_${segOrdinal}`];

    // Try to read the full domain document for richer content
    let fullContent = "";
    let frontmatter: DomainDocFrontmatter = {};
    const docPath = join(dir, doc.rel_path);

    if (existsSync(docPath)) {
      try {
        const raw = await readFile(docPath, "utf-8");
        const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (fmMatch) {
          try {
            frontmatter = (parseYAML(fmMatch[1]) as DomainDocFrontmatter) || {};
          } catch {}
          fullContent = raw.slice(fmMatch[0].length).trim();
        } else {
          fullContent = raw.trim();
        }
      } catch {}
    }

    // Entity: the document itself
    allEntities.push({
      name: doc.id,
      type: "config_item" as any,
    });

    // Entities from document metadata
    const docEntities = frontmatter.entities || doc.entities || [];
    for (const entName of docEntities) {
      if (entName) {
        allEntities.push({
          name: entName.toLowerCase(),
          type: guessEntityType(entName),
        });
        allFacts.push({
          subject: doc.id,
          predicate: "references_entity",
          object_value: entName.toLowerCase(),
          fact_kind: "state",
          assertion_class: "deterministic",
          confidence: 0.95,
          segment_ids: segRef,
        });
      }
    }

    // File path entities
    const docPaths = frontmatter.paths || doc.paths || [];
    for (const fp of docPaths.slice(0, 20)) {
      if (fp && fp.startsWith("/")) {
        allEntities.push({ name: fp, type: "file" as any });
        allFacts.push({
          subject: doc.id,
          predicate: "references_path",
          object_value: fp,
          fact_kind: "state",
          assertion_class: "deterministic",
          confidence: 1.0,
          segment_ids: segRef,
        });
      }
    }

    // Fact: document kind
    allFacts.push({
      subject: doc.id,
      predicate: "codex_memory_kind",
      object_value: doc.kind,
      fact_kind: "state",
      assertion_class: "deterministic",
      confidence: 1.0,
      segment_ids: segRef,
    });

    // Fact: domain membership
    allFacts.push({
      subject: doc.id,
      predicate: "codex_domain",
      object_value: doc.domain,
      fact_kind: "state",
      assertion_class: "deterministic",
      confidence: 1.0,
      segment_ids: segRef,
    });

    // Fact: the curated knowledge itself (summary + content)
    const factKind = KIND_TO_FACT_KIND[doc.kind] || "state";
    const summaryText = doc.summary || frontmatter.summary || doc.title;
    if (summaryText) {
      allFacts.push({
        subject: doc.id,
        predicate: `codex_${doc.kind}`,
        object_value: summaryText,
        fact_kind: factKind as any,
        assertion_class: "human_curated" as any,
        confidence: doc.confidence || frontmatter.confidence || 0.9,
        valid_from: frontmatter.created_at || doc.updated_at,
        segment_ids: segRef,
      });
    }

    // Fact: source session linkage (for provenance)
    const sourceSession = frontmatter.source_session_id;
    if (sourceSession) {
      allFacts.push({
        subject: doc.id,
        predicate: "source_session",
        object_value: sourceSession,
        fact_kind: "state",
        assertion_class: "deterministic",
        confidence: 1.0,
        segment_ids: segRef,
      });

      // Resolve project from instance data
      const inst = instanceMap.get(sourceSession);
      if (inst) {
        allFacts.push({
          subject: doc.id,
          predicate: "source_project",
          object_value: resolveProject(inst.cwd, inst.git_root),
          fact_kind: "state",
          assertion_class: "deterministic",
          confidence: 1.0,
          segment_ids: segRef,
        });
      }
    }

    // Tags as facts
    const tags = frontmatter.tags || doc.tags || [];
    for (const tag of tags) {
      allFacts.push({
        subject: doc.id,
        predicate: "tagged",
        object_value: tag,
        fact_kind: "state",
        assertion_class: "deterministic",
        confidence: 1.0,
        segment_ids: segRef,
      });
    }

    // Build segment from content
    const segmentContent = [
      `Kind: ${doc.kind}`,
      `Domain: ${doc.domain}`,
      `Title: ${doc.title}`,
      `Summary: ${doc.summary || "N/A"}`,
      `Confidence: ${doc.confidence}`,
      "",
      fullContent ? fullContent.slice(0, 2000) : `[Index-only: ${doc.summary}]`,
    ].join("\n");

    allSegments.push({
      ordinal: segOrdinal,
      section_label: doc.title.slice(0, 100),
      content: segmentContent,
      line_start: 1,
      line_end: segmentContent.split("\n").length,
    });
  }

  // ── Instance-level facts (session context) ─────────────────────────────
  for (const [sessionId, inst] of instanceMap) {
    const segRef = [`seg_1`]; // Reference first segment for general context

    allEntities.push({ name: sessionId, type: "session" as any });

    allFacts.push({
      subject: sessionId,
      predicate: "codex_instance_cwd",
      object_value: inst.cwd,
      fact_kind: "state",
      assertion_class: "deterministic",
      confidence: 1.0,
      segment_ids: segRef,
    });

    if (inst.git_root) {
      allFacts.push({
        subject: sessionId,
        predicate: "codex_instance_git_root",
        object_value: inst.git_root,
        fact_kind: "state",
        assertion_class: "deterministic",
        confidence: 1.0,
        segment_ids: segRef,
      });
    }

    for (const domain of inst.domain_snapshot) {
      allFacts.push({
        subject: sessionId,
        predicate: "codex_instance_domain",
        object_value: domain,
        fact_kind: "state",
        assertion_class: "deterministic",
        confidence: 1.0,
        segment_ids: segRef,
      });
    }
  }

  const episode: Episode = {
    type: "session",
    title: `CODEX_SHARED scan: ${index.documents.length} documents, ${index.domains.length} domains`,
    start_at: index.generated_at,
    summary: `Scanned CODEX_SHARED memory: ${index.documents.length} documents across ${index.domains.length} domains (${[...new Set(index.documents.map((d) => d.kind))].join(", ")}). ${instanceMap.size} session instances loaded for project resolution.`,
  };

  return {
    entities: deduplicateEntities(allEntities),
    facts: allFacts,
    segments: allSegments,
    episode,
    scope_path: "codex:shared",
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function resolveProject(cwd: string, gitRoot?: string): string {
  const path = gitRoot || cwd;
  const parts = path.split("/").filter(Boolean);
  if (parts.includes("tools")) {
    const idx = parts.indexOf("tools");
    return parts.slice(idx + 1).join("/") || parts[parts.length - 1];
  }
  if (parts.includes("OpsVault")) {
    const idx = parts.indexOf("OpsVault");
    return parts.slice(idx).join("/") || "OpsVault";
  }
  return parts[parts.length - 1] || "unknown";
}

function guessEntityType(name: string): string {
  const lower = name.toLowerCase();
  const devices = (process.env.BRAINCORE_KNOWN_DEVICES || "server-a,server-b,workstation").split(",").map(d => d.trim());
  const services = [
    "docker", "nginx", "postgresql", "postgres", "redis", "vllm",
    "systemd", "caddy", "chrome", "xvfb",
  ];

  if (devices.some((d) => lower.includes(d))) return "device";
  if (services.some((s) => lower.includes(s))) return "service";
  return "config_item";
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
