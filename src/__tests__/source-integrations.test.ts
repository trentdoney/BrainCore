import { describe, expect, test } from "bun:test";
import { execFile } from "child_process";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { parseAsanaExport } from "../extract/asana-parser";
import { parseGitCommits } from "../extract/git-parser";
import { ensureSourceArtifact } from "../extract/source-loader";

const execFileAsync = promisify(execFile);

process.env.BRAINCORE_POSTGRES_DSN ??= "postgres://test:test@localhost:5432/test";

interface SqlCall {
  text: string;
  values: unknown[];
}

function makeSqlStub(responses: unknown[][]) {
  const calls: SqlCall[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve(responses.shift() ?? []);
  }) as any;
  return { sql, calls };
}

describe("source integration parsers", () => {
  test("parses Asana JSON export with tenant-stable source key and scope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "braincore-asana-"));
    const path = join(dir, "tasks.json");
    await writeFile(path, JSON.stringify({
      data: [{
        gid: "121",
        name: "Ship source integrations",
        completed: false,
        assignee: { name: "Example Operator" },
        projects: [{ name: "BrainCore" }],
        tags: [{ name: "Source integration" }],
        memberships: [{
          project: { name: "Example Intake" },
          section: { name: "Review" },
        }],
        custom_fields: [{ name: "Target Project", display_value: "BrainCore" }],
        notes: "Dry-run first.",
      }],
    }));

    const [item] = await parseAsanaExport(path);

    expect(item.sourceType).toBe("asana_task");
    expect(item.sourceKey).toBe("asana_task:121");
    expect(item.result.source_key).toBe("asana_task:121");
    expect(item.result.scope_path).toBe("asana:task:121");
    expect(item.result.entities).toContainEqual({ name: "BrainCore", type: "project" });
    expect(item.result.entities).toContainEqual({ name: "Example Intake", type: "project" });
    expect(item.result.facts).toContainEqual(expect.objectContaining({
      subject: "asana_task:121",
      predicate: "title",
      object_value: "Ship source integrations",
    }));
    expect(item.result.facts).toContainEqual(expect.objectContaining({
      subject: "asana_task:121",
      predicate: "custom_field:Target Project",
      object_value: "BrainCore",
    }));
  });

  test("rejects malformed Asana JSONL with line number", async () => {
    const dir = await mkdtemp(join(tmpdir(), "braincore-asana-bad-"));
    const path = join(dir, "tasks.jsonl");
    await writeFile(path, "{\"gid\":\"1\"}\nnot-json\n");

    await expect(parseAsanaExport(path)).rejects.toThrow("Malformed JSONL at line 2");
  });

  test("rejects duplicate source keys in one Asana export", async () => {
    const dir = await mkdtemp(join(tmpdir(), "braincore-asana-dup-"));
    const path = join(dir, "tasks.json");
    await writeFile(path, JSON.stringify([
      { gid: "121", name: "One" },
      { gid: "121", name: "Two" },
    ]));

    await expect(parseAsanaExport(path)).rejects.toThrow("Duplicate source_key in export: asana_task:121");
  });

  test("parses git commit JSONL export with repo slug and sha source key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "braincore-git-"));
    const path = join(dir, "commits.jsonl");
    await writeFile(path, JSON.stringify({
      repo_slug: "BrainCore",
      sha: "abcdef1234567890",
      subject: "Add source integrations",
      author: { name: "Worker B", email: "worker@example.com" },
      committed_at: "2026-04-25T12:00:00Z",
      files: ["src/cli.ts"],
    }) + "\n");

    const [item] = await parseGitCommits(path);

    expect(item.sourceType).toBe("git_commit");
    expect(item.sourceKey).toBe("git_commit:BrainCore:abcdef1234567890");
    expect(item.result.scope_path).toBe("git:BrainCore/commit:abcdef1234567890");
    expect(item.result.facts).toContainEqual(expect.objectContaining({
      subject: "git_commit:BrainCore:abcdef1234567890",
      predicate: "touched_file",
      object_value: "src/cli.ts",
    }));
  });

  test("parses local git repo commits with touched files", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "braincore-git-repo-"));
    await execFileAsync("git", ["-C", repoDir, "init"]);
    await execFileAsync("git", ["-C", repoDir, "config", "user.name", "Test Author"]);
    await execFileAsync("git", ["-C", repoDir, "config", "user.email", "test@example.com"]);
    await writeFile(join(repoDir, "README.md"), "hello\n");
    await execFileAsync("git", ["-C", repoDir, "add", "README.md"]);
    await execFileAsync("git", ["-C", repoDir, "commit", "-m", "Add readme"]);

    const [item] = await parseGitCommits(repoDir);

    expect(item.sourceType).toBe("git_commit");
    expect(item.sourceKey).toContain("git_commit:braincore-git-repo-");
    expect(item.result.facts).toContainEqual(expect.objectContaining({
      predicate: "touched_file",
      object_value: "README.md",
    }));
  });

  test("artifact creation is scoped by active tenant and source scope", async () => {
    const { sql, calls } = makeSqlStub([
      [],
      [{ artifact_id: "00000000-0000-0000-0000-000000000001" }],
    ]);

    const result = await ensureSourceArtifact(sql, {
      sourceKey: "asana_task:121",
      sourceType: "asana_task",
      originalPath: "/tmp/asana.json",
      sourceContent: "{\"gid\":\"121\"}",
      result: {
        entities: [],
        facts: [],
        segments: [],
        episode: { type: "asana_task", title: "Task" },
        scope_path: "asana:task:121",
        source_key: "asana_task:121",
      },
    }, "tenant-a");

    expect(result).toEqual({
      artifactId: "00000000-0000-0000-0000-000000000001",
      created: true,
    });
    expect(calls[0].text).toContain("WHERE source_key = ?");
    expect(calls[0].text).toContain("AND tenant = ?");
    expect(calls[0].values).toContain("asana_task:121");
    expect(calls[0].values).toContain("tenant-a");
    expect(calls[1].text).toContain("source_key, source_type, original_path");
    expect(calls[1].text).toContain("scope_path, can_query_raw");
    expect(calls[1].values).toContain("asana_task");
    expect(calls[1].values).toContain("asana:task:121");
    expect(calls[1].values).toContain("tenant-a");
  });
});
