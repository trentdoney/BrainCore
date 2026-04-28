import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliPath = join(repoRoot, "src/cli.ts");

function runCli(args: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), "braincore-cli-help-"));
  const env = { ...process.env, BRAINCORE_POSTGRES_DSN: "" };

  try {
    return spawnSync(process.execPath, [cliPath, ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("project CLI help", () => {
  for (const args of [
    ["project", "--help"],
    ["project", "-h"],
    ["project", "help"],
  ]) {
    test(`${args.join(" ")} exits before loading db config`, () => {
      const result = runCli(args);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: braincore project <subcommand> [options]");
      expect(result.stderr).not.toContain("Missing required environment variable");
    });
  }

  for (const args of [
    ["project", "archive", "--help"],
    ["project", "archive", "-h"],
  ]) {
    test(`${args.join(" ")} exits before loading db config`, () => {
      const result = runCli(args);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: braincore project archive <name> --reason 'text'");
      expect(result.stderr).not.toContain("Missing required environment variable");
    });
  }
});
