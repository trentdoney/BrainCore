import { readFile, readdir } from "fs/promises";
import { basename, join } from "path";
import { parse as parseYAML } from "yaml";
import type { DeterministicResult, Entity, Fact, Segment } from "./deterministic";
import { assertUniqueSourceKeys, type SourceExtraction } from "./source-export";

interface PaiAutoFrontmatter {
  name?: string;
  description?: string;
  type?: string;
  tags?: string[];
  originSessionId?: string;
  created?: string;
  updated?: string;
}

export async function parsePaiAutoMemory(memoryDir: string): Promise<SourceExtraction[]> {
  const files = (await readdir(memoryDir))
    .filter((file) => file.endsWith(".md") && file !== "MEMORY.md")
    .sort();
  const items: SourceExtraction[] = [];

  for (const file of files) {
    const path = join(memoryDir, file);
    const raw = await readFile(path, "utf-8");
    const slug = basename(file, ".md");
    const { frontmatter, body } = parseFrontmatter(raw);
    const title = frontmatter.name || slug;
    const memoryType = frontmatter.type || inferType(slug);
    const sourceKey = `pai_auto_memory:${safeKeyPart(slug)}`;
    const segment: Segment = {
      ordinal: 1,
      section_label: title.slice(0, 100),
      content: buildSegmentContent(frontmatter, body, slug).slice(0, 8000),
      line_start: 1,
      line_end: raw.split(/\r?\n/).length,
    };
    const segRef = ["seg_1"];
    const entities: Entity[] = [
      { name: sourceKey, type: "config_item" as any },
    ];
    const facts: Fact[] = [
      fact(sourceKey, "pai_auto_memory_type", memoryType, "state", "deterministic", segRef),
      fact(sourceKey, "pai_auto_memory_content", body.slice(0, 4000), factKindForType(memoryType), "human_curated", segRef),
    ];

    if (frontmatter.description) {
      facts.push(fact(sourceKey, "description", frontmatter.description, "state", "human_curated", segRef));
    }
    if (frontmatter.originSessionId) {
      facts.push(fact(sourceKey, "origin_session", frontmatter.originSessionId, "state", "deterministic", segRef));
      entities.push({ name: frontmatter.originSessionId, type: "session" as any });
    }
    for (const tag of frontmatter.tags || []) {
      facts.push(fact(sourceKey, "tagged", tag, "state", "deterministic", segRef));
    }

    const result: DeterministicResult = {
      entities,
      facts,
      segments: [segment],
      episode: {
        type: "session",
        title: `PAI auto-memory import: ${title}`,
        start_at: frontmatter.created,
        summary: `Imported one PAI auto-memory file with type=${memoryType}.`,
      },
      scope_path: `assistant:pai/auto/${memoryType}`,
      source_key: sourceKey,
    };

    items.push({
      sourceKey,
      sourceType: "pai_auto_memory",
      originalPath: path,
      sourceContent: raw,
      result,
    });
  }

  assertUniqueSourceKeys(items);
  return items;
}

function parseFrontmatter(raw: string): { frontmatter: PaiAutoFrontmatter; body: string } {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return { frontmatter: {}, body: raw.trim() };
  try {
    return {
      frontmatter: (parseYAML(fmMatch[1]) as PaiAutoFrontmatter) || {},
      body: raw.slice(fmMatch[0].length).trim(),
    };
  } catch {
    return { frontmatter: {}, body: raw.slice(fmMatch[0].length).trim() };
  }
}

function buildSegmentContent(frontmatter: PaiAutoFrontmatter, body: string, slug: string): string {
  return [
    "Source: PAI auto memory",
    `Slug: ${slug}`,
    `Name: ${frontmatter.name || slug}`,
    `Type: ${frontmatter.type || inferType(slug)}`,
    `Description: ${frontmatter.description || "none"}`,
    `Origin session: ${frontmatter.originSessionId || "none"}`,
    `Tags: ${(frontmatter.tags || []).join(", ") || "none"}`,
    "",
    body,
  ].join("\n");
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
    confidence: assertionClass === "deterministic" ? 1.0 : 0.9,
    segment_ids: segmentIds,
  };
}

function inferType(slug: string): string {
  if (slug.startsWith("feedback_")) return "feedback";
  if (slug.startsWith("project_")) return "project";
  if (slug.startsWith("playbook_")) return "playbook";
  if (slug.startsWith("reference_")) return "reference";
  return "auto";
}

function factKindForType(memoryType: string): string {
  if (memoryType === "feedback") return "constraint";
  if (memoryType === "playbook") return "remediation";
  return "state";
}

function safeKeyPart(value: string): string {
  return value.trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_.:-]/g, "_");
}
