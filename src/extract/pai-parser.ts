/**
 * pai-parser.ts — Parse PAI AUTO memory files (markdown with YAML frontmatter).
 * Extracts entities and facts based on memory type (feedback, project, reference, user).
 * All facts tagged assertion_class='human_curated' (high trust).
 */

import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import { parse as parseYAML } from "yaml";
import type { DeterministicResult, Entity, Fact, Segment, Episode } from "./deterministic";

const PAI_MEMORY_DIR = process.env.PAI_MEMORY_DIR || "./data/memory";

interface PAIFrontmatter {
  name?: string;
  description?: string;
  type?: string;
  tags?: string[];
  created?: string;
  updated?: string;
}

/**
 * Parse all PAI AUTO memory files from the standard directory.
 * Returns a combined DeterministicResult with all memories.
 */
export async function parsePAIMemory(
  memoryPath?: string,
): Promise<DeterministicResult> {
  const dir = memoryPath || PAI_MEMORY_DIR;

  if (!existsSync(dir)) {
    throw new Error(`PAI memory directory not found: ${dir}`);
  }

  const files = await readdir(dir);
  const mdFiles = files.filter((f) => f.endsWith(".md") && f !== "MEMORY.md");

  const allEntities: Entity[] = [];
  const allFacts: Fact[] = [];
  const allSegments: Segment[] = [];
  let segOrdinal = 0;

  for (const file of mdFiles) {
    const filePath = join(dir, file);
    const raw = await readFile(filePath, "utf-8");
    const slug = basename(file, ".md");

    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    let frontmatter: PAIFrontmatter = {};
    let body = raw;

    if (fmMatch) {
      try {
        frontmatter = (parseYAML(fmMatch[1]) as PAIFrontmatter) || {};
      } catch {
        // Skip malformed frontmatter
      }
      body = raw.slice(fmMatch[0].length).trim();
    }

    const memType = detectMemoryType(slug);

    allEntities.push({
      name: slug,
      type: "config_item" as any,
    });

    segOrdinal++;
    allSegments.push({
      ordinal: segOrdinal,
      section_label: frontmatter.name || slug,
      content: body.slice(0, 2000),
      line_start: 1,
      line_end: body.split("\n").length,
    });

    const segRef = [`seg_${segOrdinal}`];

    allFacts.push({
      subject: slug,
      predicate: "memory_type",
      object_value: memType,
      fact_kind: "state",
      assertion_class: "deterministic",
      confidence: 1.0,
      segment_ids: segRef,
    });

    if (frontmatter.description) {
      allFacts.push({
        subject: slug,
        predicate: "description",
        object_value: frontmatter.description,
        fact_kind: "state",
        assertion_class: "human_curated" as any,
        confidence: 1.0,
        segment_ids: segRef,
      });
    }

    const typeFacts = extractTypeFacts(slug, memType, body, segRef);
    allFacts.push(...typeFacts);

    const referencedEntities = extractReferencedEntities(body);
    for (const ent of referencedEntities) {
      allEntities.push(ent);
      allFacts.push({
        subject: slug,
        predicate: "references",
        object_value: ent.name,
        fact_kind: "state",
        assertion_class: "human_curated" as any,
        confidence: 0.9,
        segment_ids: segRef,
      });
    }

    if (frontmatter.tags) {
      for (const tag of frontmatter.tags) {
        allFacts.push({
          subject: slug,
          predicate: "tagged",
          object_value: tag,
          fact_kind: "state",
          assertion_class: "deterministic",
          confidence: 1.0,
          segment_ids: segRef,
        });
      }
    }
  }

  const episode: Episode = {
    type: "session",
    title: `PAI memory scan: ${mdFiles.length} files`,
    start_at: new Date().toISOString(),
    summary: `Scanned ${mdFiles.length} PAI AUTO memory files. Found ${allEntities.length} entities and ${allFacts.length} facts.`,
  };

  return {
    entities: deduplicateEntities(allEntities),
    facts: allFacts,
    segments: allSegments,
    episode,
    scope_path: "pai:memory/auto",
  };
}

function detectMemoryType(slug: string): string {
  if (slug.startsWith("feedback_")) return "feedback";
  if (slug.startsWith("project_")) return "project";
  if (slug.startsWith("reference_")) return "reference";
  if (slug.startsWith("user_")) return "user";
  return "general";
}

function extractTypeFacts(
  slug: string,
  memType: string,
  body: string,
  segRef: string[],
): Fact[] {
  const facts: Fact[] = [];

  switch (memType) {
    case "feedback": {
      const firstLine = body.split("\n").find((l) => l.trim())?.trim() || "";
      if (firstLine) {
        facts.push({
          subject: slug,
          predicate: "behavioral_rule",
          object_value: firstLine.slice(0, 500),
          fact_kind: "constraint",
          assertion_class: "human_curated" as any,
          confidence: 1.0,
          segment_ids: segRef,
        });
      }
      break;
    }
    case "project": {
      const kvPattern = /^[-*]\s*\*\*(.+?)\*\*[:\s]+(.+)/gm;
      let match;
      while ((match = kvPattern.exec(body)) !== null) {
        facts.push({
          subject: slug,
          predicate: `project_${match[1].toLowerCase().replace(/\s+/g, "_")}`,
          object_value: match[2].trim(),
          fact_kind: "state",
          assertion_class: "human_curated" as any,
          confidence: 0.95,
          segment_ids: segRef,
        });
      }
      break;
    }
    case "reference": {
      facts.push({
        subject: slug,
        predicate: "reference_content",
        object_value: body.slice(0, 1000),
        fact_kind: "state",
        assertion_class: "human_curated" as any,
        confidence: 1.0,
        segment_ids: segRef,
      });
      break;
    }
  }

  return facts;
}

function extractReferencedEntities(body: string): Entity[] {
  const entities: Entity[] = [];
  const seen = new Set<string>();

  const devices = (process.env.BRAINCORE_KNOWN_DEVICES || "server-a,server-b,workstation").split(",");
  const devicePattern = new RegExp("\\b(" + devices.join("|") + ")\\b", "gi");
  let match;
  while ((match = devicePattern.exec(body)) !== null) {
    const name = match[1].toLowerCase().replace(/\s+/g, "_");
    if (!seen.has(name)) {
      seen.add(name);
      entities.push({ name, type: "device" });
    }
  }

  const servicePattern = /\b(docker|nginx|postgresql|postgres|redis|vllm|braincore|grafana)\b/gi;
  while ((match = servicePattern.exec(body)) !== null) {
    const name = match[1].toLowerCase();
    if (!seen.has(name)) {
      seen.add(name);
      entities.push({ name, type: "service" });
    }
  }

  return entities;
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
