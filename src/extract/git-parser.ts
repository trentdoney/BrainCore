import { basename, resolve } from "path";
import { existsSync, statSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import type { DeterministicResult, Entity, Fact } from "./deterministic";
import {
  assertUniqueSourceKeys,
  readJsonOrJsonl,
  toSafeString,
  type SourceExtraction,
} from "./source-export";

const execFileAsync = promisify(execFile);

interface GitCommitRecord {
  sha?: unknown;
  hash?: unknown;
  commit?: unknown;
  repo_slug?: unknown;
  repo?: unknown;
  repository?: unknown;
  author_name?: unknown;
  author_email?: unknown;
  author?: string | { name?: unknown; email?: unknown };
  authored_at?: unknown;
  committed_at?: unknown;
  date?: unknown;
  subject?: unknown;
  message?: unknown;
  body?: unknown;
  files?: unknown;
}

function normalizeRepoSlug(value: string): string {
  const slug = value.trim().replace(/\\/g, "/").replace(/^.*\//, "");
  return slug.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

function normalizeSha(value: unknown): string {
  const sha = toSafeString(value);
  if (!sha || !/^[a-f0-9]{7,64}$/i.test(sha)) {
    throw new Error("Malformed git commit export: missing or invalid sha");
  }
  return sha.toLowerCase();
}

function author(record: GitCommitRecord): { name?: string; email?: string } {
  if (typeof record.author === "object" && record.author) {
    return {
      name: toSafeString(record.author.name),
      email: toSafeString(record.author.email),
    };
  }
  return {
    name: toSafeString(record.author_name) || (typeof record.author === "string" ? record.author : undefined),
    email: toSafeString(record.author_email),
  };
}

function fileList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((file) => toSafeString(file)).filter((file): file is string => Boolean(file));
}

function fact(
  sourceKey: string,
  subject: string,
  predicate: string,
  objectValue: unknown,
  factKind: string = "event",
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

function parseCommitRecord(record: unknown, fallbackRepoSlug: string, originalPath: string): SourceExtraction {
  if (!record || typeof record !== "object") {
    throw new Error("Malformed git commit export: record is not an object");
  }
  const commit = record as GitCommitRecord;
  const sha = normalizeSha(commit.sha || commit.hash || commit.commit);
  const repoSlug = normalizeRepoSlug(
    toSafeString(commit.repo_slug) ||
    toSafeString(commit.repo) ||
    toSafeString(commit.repository) ||
    fallbackRepoSlug,
  );
  const sourceKey = `git_commit:${repoSlug}:${sha}`;
  const subject = `git_commit:${repoSlug}:${sha}`;
  const title = toSafeString(commit.subject) ||
    toSafeString(commit.message)?.split(/\r?\n/)[0] ||
    "(no commit subject)";
  const message = toSafeString(commit.message) || toSafeString(commit.body) || title;
  const when = toSafeString(commit.committed_at) || toSafeString(commit.authored_at) || toSafeString(commit.date);
  const who = author(commit);
  const files = fileList(commit.files);

  const entities: Entity[] = [
    { name: repoSlug, type: "project" },
    { name: subject, type: "config_item" },
    ...files.map((file) => ({ name: file, type: "file" })),
  ];
  if (who.name) entities.push({ name: `git_author:${who.name}`, type: "config_item" });

  const facts: Fact[] = [
    fact(sourceKey, subject, "repo", repoSlug),
    fact(sourceKey, subject, "subject", title),
    fact(sourceKey, subject, "message", message),
  ];
  if (when) facts.push(fact(sourceKey, subject, "committed_at", when));
  if (who.name) facts.push(fact(sourceKey, subject, "author_name", who.name));
  if (who.email) facts.push(fact(sourceKey, subject, "author_email", who.email));
  for (const file of files) facts.push(fact(sourceKey, subject, "touched_file", file));

  const body = [
    `Git commit: ${title}`,
    `repo: ${repoSlug}`,
    `sha: ${sha}`,
    when ? `committed_at: ${when}` : undefined,
    who.name ? `author: ${who.name}` : undefined,
    message,
    files.length ? `files:\n${files.map((file) => `- ${file}`).join("\n")}` : undefined,
  ].filter(Boolean).join("\n");

  const result: DeterministicResult = {
    entities,
    facts,
    segments: [{
      ordinal: 1,
      section_label: `git_commit:${sha.slice(0, 12)}`,
      content: body,
      line_start: 1,
      line_end: body.split(/\r?\n/).length,
    }],
    episode: {
      type: "git_commit",
      title,
      start_at: when,
      end_at: when,
      summary: message,
    },
    scope_path: `git:${repoSlug}/commit:${sha}`,
    source_key: sourceKey,
  };

  return {
    sourceKey,
    sourceType: "git_commit",
    originalPath,
    sourceContent: JSON.stringify(record),
    result,
  };
}

function looksLikeExport(path: string): boolean {
  return path.endsWith(".json") || path.endsWith(".jsonl");
}

async function parseGitLog(repoPath: string, since?: string): Promise<unknown[]> {
  const logArgs = [
    "-C",
    repoPath,
    "log",
    "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%B%x1e",
  ];
  if (since) logArgs.splice(3, 0, `${since}..HEAD`);
  const { stdout } = await execFileAsync("git", logArgs, {
    maxBuffer: 20 * 1024 * 1024,
  });

  const commits = stdout.split("\x1e").flatMap((entry): GitCommitRecord[] => {
    const trimmed = entry.trim();
    if (!trimmed) return [];
    const [sha, authorName, authorEmail, committedAt, subject, ...messageParts] = trimmed.split("\x1f");
    return [{
      sha,
      author_name: authorName,
      author_email: authorEmail,
      committed_at: committedAt,
      subject,
      message: messageParts.join("\x1f").trim() || subject,
    }];
  });

  for (const commit of commits) {
    const { stdout: filesStdout } = await execFileAsync("git", [
      "-C",
      repoPath,
      "show",
      "--format=",
      "--name-only",
      String(commit.sha),
    ], {
      maxBuffer: 20 * 1024 * 1024,
    });
    commit.files = filesStdout.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  return commits;
}

export async function parseGitCommits(inputPath: string, since?: string): Promise<SourceExtraction[]> {
  const absPath = resolve(inputPath);
  const stat = existsSync(absPath) ? statSync(absPath) : null;
  if (!stat) throw new Error(`Git commit source not found: ${inputPath}`);

  const repoSlug = normalizeRepoSlug(stat.isDirectory() ? basename(absPath) : basename(absPath).replace(/\.(jsonl?|txt)$/i, ""));
  const records = stat.isDirectory() && !looksLikeExport(absPath)
    ? await parseGitLog(absPath, since)
    : await readJsonOrJsonl(absPath);
  const parsed = records.map((record) => parseCommitRecord(record, repoSlug, inputPath));
  assertUniqueSourceKeys(parsed);
  return parsed;
}
