import { describe, expect, mock, test } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

process.env.BRAINCORE_POSTGRES_DSN ??= "postgres://test:test@localhost:5432/test";
process.env.BRAINCORE_TENANT = "test-tenant";
process.env.BRAINCORE_MAX_PROMPT_CHARS = "1000";
process.env.BRAINCORE_MAX_SEGMENTS_PER_PROMPT = "1";

mock.module("../db", () => ({
  sql: (() => {
    throw new Error("publish-safety test must not touch src/db.ts");
  }) as any,
  testConnection: async () => true,
}));

interface SqlCall {
  text: string;
  values: unknown[];
}

interface SqlFragment {
  __fragment: true;
  text: string;
  values: unknown[];
}

function isSqlFragment(value: unknown): value is SqlFragment {
  return Boolean(value && typeof value === "object" && (value as SqlFragment).__fragment);
}

function renderSql(strings: TemplateStringsArray, values: unknown[]): SqlCall {
  let text = "";
  const flatValues: unknown[] = [];

  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i >= values.length) continue;

    const value = values[i];
    if (isSqlFragment(value)) {
      text += value.text;
      flatValues.push(...value.values);
    } else {
      text += "?";
      flatValues.push(value);
    }
  }

  return { text, values: flatValues };
}

function makeSqlStub(responses: unknown[][]) {
  const calls: SqlCall[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const rendered = renderSql(strings, values);
    const normalized = rendered.text.replace(/\s+/g, " ").trim();

    if (normalized === "" || normalized.startsWith("AND ")) {
      return { __fragment: true, ...rendered } satisfies SqlFragment;
    }

    calls.push(rendered);
    return Promise.resolve(responses.shift() ?? []);
  }) as any;

  return { sql, calls };
}

describe("publishNotes safety", () => {
  test("redacts secrets and escapes YAML frontmatter in markdown output", async () => {
    const publishDir = await mkdtemp(join(tmpdir(), "braincore-publish-"));
    process.env.BRAINCORE_PUBLISH_DIR = publishDir;

    try {
      const { resetConfigForTests } = await import("../config");
      resetConfigForTests();
      const { publishNotes } = await import("../publish/markdown");
      const apiSecret = ["TEST", "REDACTION", "API", "PLACEHOLDER"].join("_");
      const bearerSecret = `Bearer ${["TEST", "REDACTION", "BEARER", "PLACEHOLDER"].join("_")}`;
      const passwordSecret = ["Test", "Password", "Placeholder"].join("");
      const yamlEscapingTitle = String.raw`Path: C:\braincore\"quoted"`;
      const yamlEscapingNarrative = String.raw`Use C:\braincore\"quoted" safely.`;
      const staleFile = join(publishDir, "old-unredacted-title.md");
      await writeFile(staleFile, "stale unredacted publish output", "utf-8");
      const { sql, calls } = makeSqlStub([
        [
          {
            memory_id: "11111111-1111-1111-1111-111111111111",
            memory_type: "pattern",
            title: `api_key=${apiSecret}`,
            narrative: `Do not publish ${bearerSecret} or password=${passwordSecret}.`,
            support_count: 2,
            contradiction_count: 0,
            confidence: 0.92,
            scope_path: "project:public-demo",
            fingerprint: "f".repeat(64),
            created_at: new Date("2026-04-01T00:00:00Z"),
            updated_at: new Date("2026-04-02T00:00:00Z"),
            scope_entity_name: "Public Demo",
          },
          {
            memory_id: "22222222-2222-2222-2222-222222222222",
            memory_type: "pattern",
            title: `api_key=${apiSecret}`,
            narrative: "Second memory with the same redacted title.",
            support_count: 1,
            contradiction_count: 0,
            confidence: 0.8,
            scope_path: "project:public-demo",
            fingerprint: "e".repeat(64),
            created_at: new Date("2026-04-01T00:00:00Z"),
            updated_at: new Date("2026-04-02T00:00:00Z"),
            scope_entity_name: "Public Demo",
          },
          {
            memory_id: "44444444-4444-4444-4444-444444444444",
            memory_type: "pattern",
            title: yamlEscapingTitle,
            narrative: yamlEscapingNarrative,
            support_count: 1,
            contradiction_count: 0,
            confidence: 0.88,
            scope_path: "project:public-demo",
            fingerprint: "d".repeat(64),
            created_at: new Date("2026-04-01T00:00:00Z"),
            updated_at: new Date("2026-04-02T00:00:00Z"),
            scope_entity_name: "Public Demo",
          },
        ],
        [{ publish_id: "33333333-3333-3333-3333-333333333333", content_hash: "old", file_path: staleFile }],
        [],
        [],
        [],
        [],
        [],
      ]);

      const result = await publishNotes(sql);
      expect(result.published).toBe(3);

      const files = await readdir(publishDir);
      expect(files).toHaveLength(3);
      expect(existsSync(staleFile)).toBe(false);
      expect(files.every((file) => !file.includes(apiSecret))).toBe(true);
      expect(files).toContain("redacted_api_key-11111111-1111-1111-1111-111111111111.md");
      expect(files).toContain("redacted_api_key-22222222-2222-2222-2222-222222222222.md");
      expect(files).toContain("path_c_braincore_quoted-44444444-4444-4444-4444-444444444444.md");

      const content = await readFile(
        join(publishDir, "redacted_api_key-11111111-1111-1111-1111-111111111111.md"),
        "utf-8",
      );
      expect(content).toContain("[REDACTED:api_key]");
      expect(content).toContain("[REDACTED:bearer_token]");
      expect(content).toContain("[REDACTED:password]");
      expect(content).not.toContain(apiSecret);
      expect(content).not.toContain(bearerSecret);
      expect(content).not.toContain(passwordSecret);
      expect(calls[0].text).toContain("m.tenant = ?");
      expect(calls[0].values).toContain("test-tenant");

      const escapedContent = await readFile(
        join(publishDir, "path_c_braincore_quoted-44444444-4444-4444-4444-444444444444.md"),
        "utf-8",
      );
      const { parse } = await import("yaml");
      const frontmatterEnd = escapedContent.indexOf("\n---", 4);
      expect(frontmatterEnd).toBeGreaterThan(4);
      const frontmatter = escapedContent.slice(4, frontmatterEnd);
      const parsedFrontmatter = parse(frontmatter) as { name?: string; description?: string };

      expect(escapedContent).toContain(`name: ${JSON.stringify(yamlEscapingTitle)}`);
      expect(escapedContent).toContain(`description: ${JSON.stringify(yamlEscapingNarrative)}`);
      expect(parsedFrontmatter.name).toBe(yamlEscapingTitle);
      expect(parsedFrontmatter.description).toBe(yamlEscapingNarrative);
    } finally {
      await rm(publishDir, { recursive: true, force: true });
    }
  });
});
