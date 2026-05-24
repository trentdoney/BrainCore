import { readFile } from "fs/promises";
import { basename } from "path";
import { createHash } from "crypto";
import type { SourceExtraction } from "./source-export";
import type { DeterministicResult, Entity, Fact, Segment } from "./deterministic";

export interface ProjectDocManifest {
  projectKey: string;
  scopePath: string;
  docs: ProjectDocManifestDoc[];
}

export interface ProjectDocManifestDoc {
  id: string;
  path: string;
  title?: string;
  sourceKey?: string;
  facts?: ProjectDocManifestFact[];
}

export interface ProjectDocManifestFact {
  subject?: string;
  predicate: string;
  objectValue: unknown;
  factKind?: string;
  confidence?: number;
  segmentLabel?: string;
}

function sanitizeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

function assertManifest(value: unknown): ProjectDocManifest {
  const manifest = value as ProjectDocManifest;
  if (!manifest || typeof manifest !== "object") throw new Error("Project doc manifest must be a JSON object.");
  if (!manifest.projectKey || typeof manifest.projectKey !== "string") throw new Error("Project doc manifest requires projectKey.");
  if (!manifest.scopePath || typeof manifest.scopePath !== "string") throw new Error("Project doc manifest requires scopePath.");
  if (!manifest.scopePath.startsWith("project:")) throw new Error("Project doc manifest scopePath must start with project:.");
  if (!Array.isArray(manifest.docs) || manifest.docs.length === 0) throw new Error("Project doc manifest requires at least one doc.");
  for (const doc of manifest.docs) {
    if (!doc.id || typeof doc.id !== "string") throw new Error("Every project doc manifest entry requires id.");
    if (!doc.path || typeof doc.path !== "string") throw new Error(`Project doc ${doc.id} requires path.`);
    if (!Array.isArray(doc.facts) || doc.facts.length === 0) throw new Error(`Project doc ${doc.id} requires explicit facts; no raw-doc promotion is allowed.`);
    for (const fact of doc.facts) {
      if (!fact.predicate || typeof fact.predicate !== "string") throw new Error(`Project doc ${doc.id} has fact without predicate.`);
      if (fact.objectValue === undefined || fact.objectValue === null || String(fact.objectValue).trim() === "") {
        throw new Error(`Project doc ${doc.id} has empty fact value for ${fact.predicate}.`);
      }
    }
  }
  return manifest;
}

function splitSegments(raw: string): Segment[] {
  const lines = raw.split(/\r?\n/);
  const segments: Segment[] = [];
  let current: { label: string; start: number; lines: string[] } = { label: "Document", start: 1, lines: [] };
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    const heading = !inFence ? line.match(/^(#{1,3})\s+(.+)$/) : null;
    if (heading && current.lines.join("\n").trim()) {
      segments.push({
        ordinal: segments.length + 1,
        section_label: current.label,
        content: current.lines.join("\n").trim(),
        line_start: current.start,
        line_end: i,
      });
      current = { label: heading[2].trim(), start: i + 1, lines: [line] };
    } else {
      if (heading && !current.lines.join("\n").trim()) current.label = heading[2].trim();
      current.lines.push(line);
    }
  }
  if (current.lines.join("\n").trim()) {
    segments.push({
      ordinal: segments.length + 1,
      section_label: current.label,
      content: current.lines.join("\n").trim(),
      line_start: current.start,
      line_end: lines.length,
    });
  }
  return segments.length > 0 ? segments : [{ ordinal: 1, section_label: "Document", content: raw.trim(), line_start: 1, line_end: lines.length }];
}

function factSegmentIds(fact: ProjectDocManifestFact, segments: Segment[]): string[] {
  if (fact.segmentLabel) {
    const needle = fact.segmentLabel.toLowerCase();
    const match = segments.find((segment) => segment.section_label.toLowerCase().includes(needle));
    if (match) return [`seg_${match.ordinal}`];
  }
  return [`seg_${segments[0].ordinal}`];
}

export async function parseProjectDocManifest(path: string): Promise<SourceExtraction[]> {
  const manifestRaw = await readFile(path, "utf-8");
  const manifest = assertManifest(JSON.parse(manifestRaw));
  const items: SourceExtraction[] = [];
  const seen = new Set<string>();

  for (const doc of manifest.docs) {
    const raw = await readFile(doc.path, "utf-8");
    const docId = sanitizeId(doc.id);
    const sourceKey = doc.sourceKey ?? `project_doc:${sanitizeId(manifest.projectKey)}:${docId}:${sha256(doc.path).slice(0, 10)}`;
    if (seen.has(sourceKey)) throw new Error(`Duplicate project_doc sourceKey: ${sourceKey}`);
    seen.add(sourceKey);

    const segments = splitSegments(raw);
    const entities: Entity[] = [
      { name: manifest.projectKey, type: "project" },
      { name: doc.path, type: "file" },
    ];
    const facts: Fact[] = doc.facts!.map((fact) => ({
      subject: fact.subject ?? manifest.projectKey,
      predicate: fact.predicate,
      object_value: fact.objectValue,
      fact_kind: fact.factKind ?? "constraint",
      assertion_class: "deterministic",
      confidence: fact.confidence ?? 1,
      segment_ids: factSegmentIds(fact, segments),
    }));

    const result: DeterministicResult = {
      entities,
      facts,
      segments,
      episode: {
        type: "project_doc",
        title: doc.title ?? basename(doc.path),
        summary: `${manifest.projectKey} project documentation evidence from ${doc.path}`,
      },
      scope_path: `${manifest.scopePath}/doc:${docId}`,
      source_key: sourceKey,
      owner_surface: "project",
      owner_key: manifest.projectKey,
    };

    items.push({
      sourceKey,
      sourceType: "project_doc",
      originalPath: doc.path,
      sourceContent: raw,
      result,
    });
  }

  return items;
}
