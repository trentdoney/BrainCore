import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, relative } from "path";
import { parseCodexShared } from "../extract/codex-shared-parser";

interface TestDoc {
  id: string;
  title: string;
  rel_path: string;
}

function doc({ id, title, rel_path }: TestDoc) {
  return {
    id,
    domain: "ops",
    kind: "decision",
    title,
    summary: `${title} summary`,
    tags: [],
    keywords: [],
    paths: [],
    entities: [],
    updated_at: "2026-04-28T00:00:00Z",
    rel_path,
    fingerprint: id,
    confidence: 0.9,
  };
}

describe("parseCodexShared", () => {
  test("does not read outside the codex shared directory from index rel_path values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "braincore-codex-shared-"));
    const outsidePath = `${dir}-outside-secret.txt`;

    try {
      const domainsDir = join(dir, "_domains", "ops");
      await mkdir(domainsDir, { recursive: true });

      await writeFile(join(domainsDir, "safe.md"), "---\nsummary: Safe note\n---\nallowed content\n");
      await writeFile(outsidePath, "outside secret content\nroot:x:0:0\n");
      await symlink(outsidePath, join(domainsDir, "linked-secret.md"));

      await writeFile(
        join(dir, "_index.json"),
        JSON.stringify({
          schema_version: 1,
          generated_at: "2026-04-28T00:00:00Z",
          domains: [{ domain: "ops", count: 5, latest_updated_at: "2026-04-28T00:00:00Z" }],
          documents: [
            doc({ id: "safe-doc", title: "Safe", rel_path: "_domains/ops/safe.md" }),
            doc({ id: "traversal-doc", title: "Traversal", rel_path: relative(dir, outsidePath) }),
            doc({ id: "passwd-doc", title: "Passwd", rel_path: "../../../../etc/passwd" }),
            doc({ id: "absolute-doc", title: "Absolute", rel_path: outsidePath }),
            doc({ id: "symlink-doc", title: "Symlink", rel_path: "_domains/ops/linked-secret.md" }),
          ],
        }),
      );

      const result = await parseCodexShared(dir);
      const segments = new Map(result.segments.map((segment) => [segment.section_label, segment.content]));

      expect(segments.get("Safe")).toContain("allowed content");

      for (const title of ["Traversal", "Passwd", "Absolute", "Symlink"]) {
        const content = segments.get(title);
        expect(content).toContain(`[Index-only: ${title} summary]`);
        expect(content).not.toContain("outside secret content");
        expect(content).not.toContain("root:x:0:0");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outsidePath, { force: true });
    }
  });
});
