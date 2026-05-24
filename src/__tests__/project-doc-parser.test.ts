import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { parseProjectDocManifest } from "../extract/project-doc-parser";

process.env.BRAINCORE_POSTGRES_DSN ??= "postgres://test:test@localhost:5432/test";

describe("project doc parser", () => {
  test("parses only manifest-selected facts with project scope and evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "braincore-project-doc-"));
    const docPath = join(dir, "README.md");
    const manifestPath = join(dir, "manifest.json");
    await writeFile(docPath, [
      "# Project Ops",
      "",
      "## Authority Model",
      "The task tracker is the source of truth for task state.",
      "The legacy scheduler is retired.",
    ].join("\n"));
    await writeFile(manifestPath, JSON.stringify({
      projectKey: "example_project",
      scopePath: "project:example_project",
      docs: [{
        id: "authority-model",
        path: docPath,
        title: "Authority model",
        facts: [{
          predicate: "runtime_authority",
          objectValue: "The legacy scheduler is retired; local runtime owners are authoritative.",
          factKind: "constraint",
          segmentLabel: "Authority Model",
        }],
      }],
    }));

    const [item] = await parseProjectDocManifest(manifestPath);

    expect(item.sourceType).toBe("project_doc");
    expect(item.sourceKey).toMatch(/^project_doc:example_project:authority-model:/);
    expect(item.result.scope_path).toBe("project:example_project/doc:authority-model");
    expect(item.result.entities).toContainEqual({ name: "example_project", type: "project" });
    expect(item.result.facts).toHaveLength(1);
    expect(item.result.facts[0]).toMatchObject({
      subject: "example_project",
      predicate: "runtime_authority",
      assertion_class: "deterministic",
      segment_ids: ["seg_2"],
    });
  });

  test("rejects manifests without explicit facts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "braincore-project-doc-bad-"));
    const docPath = join(dir, "README.md");
    const manifestPath = join(dir, "manifest.json");
    await writeFile(docPath, "# Empty\n");
    await writeFile(manifestPath, JSON.stringify({
      projectKey: "example_project",
      scopePath: "project:example_project",
      docs: [{ id: "empty", path: docPath, facts: [] }],
    }));

    await expect(parseProjectDocManifest(manifestPath)).rejects.toThrow("requires explicit facts");
  });
});
