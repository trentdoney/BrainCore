// Minimal smoke test: config + db modules load without throwing.
//
// Note: src/db.ts evaluates `postgres(config.postgres.dsn, ...)` at module
// load time, which triggers the lazy config Proxy and calls
// requiredEnv("BRAINCORE_POSTGRES_DSN"). The `postgres` client does NOT
// connect on construction (it lazy-connects on first query), so a stub
// DSN is sufficient to let the module load. We set the env var BEFORE
// the dynamic import so that the smoke test only exercises module
// load-time wiring, not runtime connectivity.
import { test, expect } from "bun:test";

if (!process.env.BRAINCORE_POSTGRES_DSN) {
  process.env.BRAINCORE_POSTGRES_DSN = "postgres://smoke:smoke@localhost:5432/smoke";
}

test("config module loads", async () => {
  const config = await import("../config");
  expect(config).toBeDefined();
});

test("db module loads", async () => {
  const db = await import("../db");
  expect(db).toBeDefined();
});
