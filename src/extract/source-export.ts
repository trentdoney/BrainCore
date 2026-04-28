import { readFile } from "fs/promises";

export interface SourceExtraction {
  sourceKey: string;
  sourceType: "asana_task" | "git_commit";
  originalPath: string;
  sourceContent: string;
  result: import("./deterministic").DeterministicResult;
}

export async function readJsonOrJsonl(path: string): Promise<unknown[]> {
  const raw = await readFile(path, "utf-8");
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (path.endsWith(".jsonl") || !trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    return trimmed.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error: any) {
        throw new Error(`Malformed JSONL at line ${index + 1}: ${error.message}`);
      }
    });
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.data)) return parsed.data;
    if (Array.isArray(parsed.tasks)) return parsed.tasks;
    if (Array.isArray(parsed.commits)) return parsed.commits;
    if (Array.isArray(parsed.items)) return parsed.items;
    return [parsed];
  } catch (error: any) {
    throw new Error(`Malformed JSON export: ${error.message}`);
  }
}

export function assertUniqueSourceKeys(items: SourceExtraction[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.sourceKey)) {
      throw new Error(`Duplicate source_key in export: ${item.sourceKey}`);
    }
    seen.add(item.sourceKey);
  }
}

export function toSafeString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}
