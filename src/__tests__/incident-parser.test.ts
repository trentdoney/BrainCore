import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { expect, test } from "bun:test";

import { parseDeterministic } from "../extract/deterministic";

test("project-owned vault incidents use path source keys and project scope", async () => {
  const root = mkdtempSync(join(tmpdir(), "braincore-incident-"));
  process.env.BRAINCORE_VAULT_ROOT = root;

  const incidentDir = join(
    root,
    "10_projects",
    "ExampleProject",
    "incidents",
    "INC-20260416-001_pipeline",
  );
  mkdirSync(incidentDir, { recursive: true });
  writeFileSync(
    join(incidentDir, "notes.md"),
    `---
type: incident
incident_id: INC-20260416-001_pipeline
title: Pipeline failure
status: resolved
opened: 2026-04-16
owner_surface: project
owner_key: ExampleProject
systems:
  - edge-node
projects:
  - ExampleProject
services: [search-service, cron]
severity: high
root_cause: bad state
fix_summary: reset worker
---

# Pipeline failure

## Summary

Resolved.
`,
  );

  const result = await parseDeterministic(incidentDir);

  expect(result.source_key).toBe("10_projects/ExampleProject/incidents/INC-20260416-001_pipeline");
  expect(result.scope_path).toBe("project:ExampleProject/incident:INC-20260416-001_pipeline");
  expect(result.owner_surface).toBe("project");
  expect(result.owner_key).toBe("ExampleProject");
  expect(result.entities).toContainEqual({ name: "ExampleProject", type: "project" });
  expect(result.facts).toContainEqual(
    expect.objectContaining({
      subject: "ExampleProject",
      predicate: "had_incident",
      object_value: "INC-20260416-001_pipeline",
    }),
  );
  expect(result.facts).toContainEqual(
    expect.objectContaining({
      subject: "edge-node",
      predicate: "had_incident",
      object_value: "INC-20260416-001_pipeline",
    }),
  );
});
