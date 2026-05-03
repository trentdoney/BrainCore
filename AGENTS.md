# AGENTS.md - BrainCore
Instructions for agents working in the BrainCore repo.

## What ships

- `src/` is the Bun write path.
- `mcp/` is the Python retrieval library.
- `examples/mcp_server/` is the reference stdio MCP server.
- `benchmarks/` holds smoke and production benchmark artifacts.
- `README.md` is the public launch surface.

## What to avoid

- Do not claim the repo ships a large MCP tool suite.
- Do not reference private hosts, home paths, or secrets.
- Do not edit user-written prose without permission.
- Do not use placeholder metrics or dead links in public docs.
- Do not create, regenerate, replace, compress, optimize, or overwrite image
  assets. Image files are human-owned release materials.

## Repo rules

1. Read before modifying.
2. Keep changes scoped to the requested files.
3. Verify before claiming completion.
4. Keep launch docs honest about smoke vs production benchmark framing.
5. Keep the changelog and benchmark evidence current when launch status changes.
6. Treat any unexpected image binary diff as a blocker. If images are needed,
   provide prompts only in chat or private planning notes and wait for the human
   owner to supply approved final assets.

## Push quality rules

These are hard rules for a public repo that clients, collaborators, and
customers may inspect:

1. Use the documented release process for public GitHub work. If local
   credentials are unavailable, stop and document the blocker rather
   than improvising a direct push.
2. Do not make routine changes directly on `main`. Use a pull request
   and let required checks run before merge.
3. Before pushing, run the local checks that cover the changed surface
   and inspect the diff for stale docs, claims, and tests.
4. If schema, migrations, benchmark claims, or public setup text changes,
   update the matching tests and evidence rows in the same commit.
5. After pushing, inspect the GitHub Actions result for the pushed SHA.
   Do not leave the repo with a failing required check.
6. Treat docs, tests, and CI as one public quality contract. If they
   disagree, the change is not done.
7. If a public branch or workflow fails, the follow-up must leave a clear
   professional repair trail: root cause, fix, verification, and PR
   context. Do not hide the failure or add vague cleanup commits.
8. Never commit generated image prompts or draft visual instructions into the
   public repo.

## Human-readable boundaries

- The example MCP server is a reference implementation only.
- The public README should describe the repo as a retrieval library
  plus an example server.
- Production-corpus metrics and smoke-regression metrics are not
  interchangeable.

## Safety

- Keep secrets out of tracked files.
- Keep private network details out of public docs.

## Notes for agents

If you need more context, read `README.md`, `ARCHITECTURE.md`, and
`benchmarks/README.md` before changing anything else.
