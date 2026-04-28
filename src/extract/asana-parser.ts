import { basename } from "path";
import type { DeterministicResult, Entity, Fact } from "./deterministic";
import {
  assertUniqueSourceKeys,
  readJsonOrJsonl,
  toSafeString,
  type SourceExtraction,
} from "./source-export";

interface AsanaTaskRecord {
  gid?: unknown;
  id?: unknown;
  name?: unknown;
  title?: unknown;
  notes?: unknown;
  description?: unknown;
  completed?: unknown;
  assignee?: { gid?: unknown; name?: unknown } | string | null;
  projects?: Array<{ gid?: unknown; name?: unknown } | string>;
  tags?: Array<{ gid?: unknown; name?: unknown } | string>;
  memberships?: Array<{
    section?: { name?: unknown };
    project?: { name?: unknown };
  }>;
  custom_fields?: Array<{
    name?: unknown;
    display_value?: unknown;
    text_value?: unknown;
    number_value?: unknown;
    enum_value?: { name?: unknown } | null;
  }>;
  created_at?: unknown;
  modified_at?: unknown;
  completed_at?: unknown;
  due_on?: unknown;
  due_at?: unknown;
  permalink_url?: unknown;
}

function namedList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === "string" ? item : toSafeString((item as any)?.name))
    .filter((item): item is string => Boolean(item));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function assigneeName(value: AsanaTaskRecord["assignee"]): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return toSafeString(value);
  return toSafeString(value.name) || toSafeString(value.gid);
}

function fact(
  sourceKey: string,
  subject: string,
  predicate: string,
  objectValue: unknown,
  factKind: string = "state",
): Fact {
  return {
    subject,
    predicate,
    object_value: objectValue,
    fact_kind: factKind,
    assertion_class: "deterministic",
    confidence: 1.0,
    segment_ids: ["seg_1"],
    metadata: { source_key: sourceKey },
  };
}

function parseTask(record: unknown, originalPath: string): SourceExtraction {
  if (!record || typeof record !== "object") {
    throw new Error("Malformed Asana task export: record is not an object");
  }
  const task = record as AsanaTaskRecord;
  const gid = toSafeString(task.gid) || toSafeString(task.id);
  if (!gid) {
    throw new Error("Malformed Asana task export: missing gid");
  }

  const sourceKey = `asana_task:${gid}`;
  const subject = `asana_task:${gid}`;
  const title = toSafeString(task.name) || toSafeString(task.title) || "(untitled Asana task)";
  const notes = toSafeString(task.notes) || toSafeString(task.description);
  const membershipProjects = (task.memberships || [])
    .map((membership) => toSafeString(membership?.project?.name))
    .filter((project): project is string => Boolean(project));
  const projects = unique([...namedList(task.projects), ...membershipProjects]);
  const tags = namedList(task.tags);
  const sections = (task.memberships || [])
    .map((membership) => toSafeString(membership?.section?.name))
    .filter((section): section is string => Boolean(section));
  const assignee = assigneeName(task.assignee);
  const customFields = (task.custom_fields || [])
    .map((field) => ({
      name: toSafeString(field?.name),
      value: toSafeString(field?.display_value) || toSafeString(field?.text_value) ||
        toSafeString(field?.number_value) || toSafeString(field?.enum_value?.name),
    }))
    .filter((field): field is { name: string; value: string } => Boolean(field.name && field.value));

  const entities: Entity[] = [
    { name: subject, type: "config_item" },
    ...projects.map((project) => ({ name: project, type: "project" })),
  ];
  if (assignee) entities.push({ name: `asana_user:${assignee}`, type: "config_item" });

  const facts: Fact[] = [
    fact(sourceKey, subject, "title", title),
    fact(sourceKey, subject, "completed", Boolean(task.completed)),
  ];
  if (notes) facts.push(fact(sourceKey, subject, "notes", notes));
  if (assignee) facts.push(fact(sourceKey, subject, "assignee", assignee));
  for (const project of projects) facts.push(fact(sourceKey, subject, "project", project));
  for (const tag of tags) facts.push(fact(sourceKey, subject, "tag", tag));
  for (const section of sections) facts.push(fact(sourceKey, subject, "section", section));
  for (const field of customFields) {
    facts.push(fact(sourceKey, subject, `custom_field:${field.name}`, field.value));
  }
  for (const [predicate, value] of [
    ["created_at", task.created_at],
    ["modified_at", task.modified_at],
    ["completed_at", task.completed_at],
    ["due_on", task.due_on || task.due_at],
    ["permalink_url", task.permalink_url],
  ] as const) {
    const text = toSafeString(value);
    if (text) facts.push(fact(sourceKey, subject, predicate, text));
  }

  const body = [
    `Asana task: ${title}`,
    `gid: ${gid}`,
    assignee ? `assignee: ${assignee}` : undefined,
    projects.length ? `projects: ${projects.join(", ")}` : undefined,
    tags.length ? `tags: ${tags.join(", ")}` : undefined,
    customFields.length ? `custom_fields: ${customFields.map((field) => `${field.name}=${field.value}`).join(", ")}` : undefined,
    notes ? `notes: ${notes}` : undefined,
  ].filter(Boolean).join("\n");

  const result: DeterministicResult = {
    entities,
    facts,
    segments: [{
      ordinal: 1,
      section_label: `asana_task:${gid}`,
      content: body,
      line_start: 1,
      line_end: body.split(/\r?\n/).length,
    }],
    episode: {
      type: "asana_task",
      title,
      start_at: toSafeString(task.created_at),
      end_at: toSafeString(task.completed_at),
      outcome: Boolean(task.completed) ? "completed" : "open",
      summary: notes || title,
    },
    scope_path: `asana:task:${gid}`,
    source_key: sourceKey,
  };

  return {
    sourceKey,
    sourceType: "asana_task",
    originalPath,
    sourceContent: JSON.stringify(record),
    result,
  };
}

export async function parseAsanaExport(path: string): Promise<SourceExtraction[]> {
  const records = await readJsonOrJsonl(path);
  const parsed = records.map((record) => parseTask(record, path || basename(path)));
  assertUniqueSourceKeys(parsed);
  return parsed;
}
