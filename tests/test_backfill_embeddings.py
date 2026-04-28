"""Focused tests for the embedding backfill client behavior."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys
import types
import unittest

import requests


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "backfill-embeddings.py"
STUB_MODULES = ("psycopg", "numpy", "pgvector", "pgvector.psycopg")
ENV_KEYS = (
    "BRAINCORE_POSTGRES_DSN",
    "BRAINCORE_EMBED_AUTH_TOKEN",
    "BRAINCORE_EMBED_MIN_INTERVAL_SECONDS",
    "BRAINCORE_EMBED_RATE_LIMIT_PER_MINUTE",
    "BRAINCORE_EMBED_RATE_LIMIT_SAFETY_SECONDS",
    "BRAINCORE_EMBED_MAX_RETRIES",
    "BRAINCORE_EMBED_MODEL",
    "BRAINCORE_TENANT",
)


class FakeResponse:
    def __init__(self, status_code, payload=None, headers=None, text=None):
        self.status_code = status_code
        self.payload = payload or {}
        self.headers = headers or {}
        self.text = text if text is not None else str(self.payload)

    def json(self):
        return self.payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.exceptions.HTTPError(f"HTTP {self.status_code}", response=self)


class BackfillEmbeddingTests(unittest.TestCase):
    def setUp(self):
        self.old_env = {key: os.environ.get(key) for key in ENV_KEYS}
        self.old_modules = {key: sys.modules.get(key) for key in STUB_MODULES}
        os.environ["BRAINCORE_POSTGRES_DSN"] = "test-dsn"
        os.environ.pop("BRAINCORE_EMBED_AUTH_TOKEN", None)
        os.environ.pop("BRAINCORE_EMBED_MIN_INTERVAL_SECONDS", None)
        os.environ.pop("BRAINCORE_EMBED_RATE_LIMIT_PER_MINUTE", None)
        os.environ.pop("BRAINCORE_EMBED_RATE_LIMIT_SAFETY_SECONDS", None)
        os.environ.pop("BRAINCORE_EMBED_MAX_RETRIES", None)
        os.environ.pop("BRAINCORE_EMBED_MODEL", None)
        os.environ.pop("BRAINCORE_TENANT", None)

        psycopg = types.ModuleType("psycopg")
        psycopg.connect = lambda _dsn: None
        sys.modules["psycopg"] = psycopg

        numpy = types.ModuleType("numpy")
        numpy.float32 = "float32"
        numpy.array = lambda value, dtype=None: value
        sys.modules["numpy"] = numpy

        pgvector = types.ModuleType("pgvector")
        pgvector_psycopg = types.ModuleType("pgvector.psycopg")
        pgvector_psycopg.register_vector = lambda _conn: None
        sys.modules["pgvector"] = pgvector
        sys.modules["pgvector.psycopg"] = pgvector_psycopg
        sys.modules.pop("backfill_embeddings", None)

    def tearDown(self):
        sys.modules.pop("backfill_embeddings", None)
        for key, value in self.old_modules.items():
            if value is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = value

        for key, value in self.old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def load_module(self):
        spec = importlib.util.spec_from_file_location("backfill_embeddings", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        sys.modules["backfill_embeddings"] = module
        self.assertIsNotNone(spec.loader)
        spec.loader.exec_module(module)
        return module

    def test_embed_batch_sends_existing_bearer_token(self):
        os.environ["BRAINCORE_EMBED_AUTH_TOKEN"] = "test-token"
        module = self.load_module()
        module.EMBED_MIN_INTERVAL_SECONDS = 0.0
        captured = {}

        def fake_post(url, json, headers, timeout):
            captured.update(
                {
                    "url": url,
                    "json": json,
                    "headers": headers,
                    "timeout": timeout,
                }
            )
            return FakeResponse(200, payload={"embeddings": [[0.25, 0.5]]})

        embeddings = module.embed_batch(["hello"], post=fake_post)

        self.assertEqual(embeddings, [[0.25, 0.5]])
        self.assertEqual(captured["url"], module.EMBED_URL)
        self.assertEqual(captured["json"], {"texts": ["hello"]})
        self.assertEqual(captured["headers"], {"Authorization": "Bearer test-token"})
        self.assertEqual(captured["timeout"], 60)

    def test_redact_text_matches_public_release_secret_classes(self):
        module = self.load_module()
        aws_secret = "=".join(["AWS_SECRET_ACCESS_KEY", "abcdefghijklmnopqrstuvwxyz1234567890ABCD"])
        aws_access_key = "".join(["AKIA", "1234567890ABCDEF"])
        google_service_account = ",".join(
            [
                '{"type":"service_account"',
                ":".join(
                    [
                        f'"{"_".join(["private", "key", "id"])}"',
                        f'"{"".join(["1234567890abcdef", "1234567890abcdef"])}"',
                    ]
                ),
                '"client_email":"svc@example.iam.gserviceaccount.com"}',
            ]
        )
        slack_webhook = "/".join(
            [
                "https://hooks.slack.com/services",
                "T00000000",
                "B00000000",
                "abcdefghijklmnopqrstuvwxyz123456",
            ]
        )
        discord_webhook = "/".join(
            [
                "https://discord.com/api/webhooks",
                "123456789012345678",
                "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
            ]
        )
        npm_token = "_".join(["npm", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"])
        telegram_token = ":".join(["123456789", "abcdefghijklmnopqrstuvwxyzABCDEFGHI"])
        docker_auth = ":".join(['"auth"', '"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO="'])
        netrc = " ".join(["machine example.com login deploy", "password", "secret-password"])
        client_secret = "=".join(["client_secret", "abcdefghijklmnop1234"])
        samples = [
            (aws_secret, "[REDACTED:aws_secret]"),
            (aws_access_key, "[REDACTED:aws_access_key]"),
            (
                google_service_account,
                "[REDACTED:google_service_account]",
            ),
            (
                slack_webhook,
                "[REDACTED:slack_webhook]",
            ),
            (
                discord_webhook,
                "[REDACTED:discord_webhook]",
            ),
            (telegram_token, "[REDACTED:telegram_bot_token]"),
            (npm_token, "[REDACTED:npm_token]"),
            (docker_auth, "[REDACTED:docker_auth]"),
            (netrc, "[REDACTED:netrc]"),
            (client_secret, "[REDACTED:api_key]"),
        ]

        for raw, replacement in samples:
            with self.subTest(raw=raw):
                redacted = module.redact_text(raw)
                self.assertIn(replacement, redacted)
                self.assertNotIn(raw, redacted)

    def test_embed_batch_retries_429_with_retry_after(self):
        module = self.load_module()
        module.EMBED_MIN_INTERVAL_SECONDS = 0.0
        module.EMBED_MAX_RETRIES = 2
        module._last_embed_request_at = 0.0
        responses = [
            FakeResponse(429, headers={"Retry-After": "3"}, text="rate limited"),
            FakeResponse(200, payload={"embeddings": [[1.0]]}),
        ]
        calls = []
        sleeps = []

        def fake_post(url, json, headers, timeout):
            calls.append((url, json, headers, timeout))
            return responses.pop(0)

        embeddings = module.embed_batch(
            ["hello"],
            post=fake_post,
            sleep=sleeps.append,
            monotonic=lambda: 10.0,
        )

        self.assertEqual(embeddings, [[1.0]])
        self.assertEqual(len(calls), 2)
        self.assertEqual(sleeps, [3.0])

    def test_embed_batch_raises_rate_limited_after_retry_exhaustion(self):
        module = self.load_module()
        module.EMBED_MIN_INTERVAL_SECONDS = 0.0
        module.EMBED_MAX_RETRIES = 1
        module._last_embed_request_at = 0.0

        def fake_post(url, json, headers, timeout):
            return FakeResponse(
                429,
                headers={"Retry-After": "4"},
                text="{\"detail\":\"Rate limit exceeded\"}",
            )

        with self.assertRaisesRegex(module.EmbeddingBackfillError, "RATE_LIMITED"):
            module.embed_batch(
                ["hello"],
                post=fake_post,
                sleep=lambda _seconds: None,
                monotonic=lambda: 10.0,
            )

    def test_embed_batch_paces_requests_under_rate_limit(self):
        module = self.load_module()
        module.EMBED_MIN_INTERVAL_SECONDS = 2.1
        module._last_embed_request_at = 100.0
        times = iter([100.5, 102.1])
        sleeps = []

        embeddings = module.embed_batch(
            ["hello"],
            post=lambda *_args, **_kwargs: FakeResponse(
                200, payload={"embeddings": [[1.0]]}
            ),
            sleep=sleeps.append,
            monotonic=lambda: next(times),
        )

        self.assertEqual(embeddings, [[1.0]])
        self.assertEqual(len(sleeps), 1)
        self.assertAlmostEqual(sleeps[0], 1.6)

    def test_print_preflight_reports_pending_counts(self):
        module = self.load_module()

        class FakeCursor:
            def __init__(self):
                self.index = 0

            def execute(self, sql, params=None):
                self.index += 1

            def fetchone(self):
                return [self.index]

        class FakeConnection:
            def cursor(self):
                return FakeCursor()

        module.check_embed_health = lambda: {"status": "ok", "embedder": True}
        module.print_preflight(FakeConnection())

    def test_check_embed_health_fails_when_embedder_false(self):
        module = self.load_module()

        class HealthResponse(FakeResponse):
            def __init__(self):
                super().__init__(200, payload={"status": "degraded", "embedder": False})

        with self.assertRaisesRegex(module.EmbeddingBackfillError, "embedder=false"):
            module.check_embed_health(get=lambda url, timeout: HealthResponse())

    def test_backfill_rolls_back_and_raises_on_unembedded_batch(self):
        module = self.load_module()

        class FakeCursor:
            def __init__(self):
                self.updates = []

            def execute(self, sql, params=None):
                if sql.lstrip().upper().startswith("UPDATE"):
                    self.updates.append((sql, params))

            def fetchall(self):
                return [(1, "one")]

        class FakeConnection:
            def __init__(self):
                self.cur = FakeCursor()
                self.commits = 0
                self.rollbacks = 0

            def cursor(self):
                return self.cur

            def commit(self):
                self.commits += 1

            def rollback(self):
                self.rollbacks += 1

        conn = FakeConnection()

        def fail_embed(_texts):
            raise module.EmbeddingBackfillError("rate limited")

        module.embed_batch = fail_embed

        with self.assertRaises(module.EmbeddingBackfillError):
            module.backfill_table(conn, "segment", "segment_id", "content", "Segments")

        self.assertEqual(conn.rollbacks, 1)
        self.assertEqual(conn.commits, 0)
        self.assertEqual(conn.cur.updates, [])

    def test_embedding_index_fingerprint_changes_by_role_and_model(self):
        module = self.load_module()

        first = module.embedding_index_fingerprint(
            "Tenant-A",
            "procedure",
            "00000000-0000-0000-0000-000000000001",
            "procedure",
            "input-sha",
            "model-a",
        )
        second = module.embedding_index_fingerprint(
            "Tenant-A",
            "procedure",
            "00000000-0000-0000-0000-000000000001",
            "evidence",
            "input-sha",
            "model-a",
        )
        third = module.embedding_index_fingerprint(
            "Tenant-A",
            "procedure",
            "00000000-0000-0000-0000-000000000001",
            "procedure",
            "input-sha",
            "model-b",
        )

        self.assertRegex(first, r"^[a-f0-9]{64}$")
        self.assertNotEqual(first, second)
        self.assertNotEqual(first, third)

    def test_populate_embedding_index_dry_run_fetches_candidates_without_insert(self):
        module = self.load_module()

        class FakeCursor:
            def __init__(self):
                self.executed = []

            def execute(self, sql, params=None):
                self.executed.append((sql, params))

            def fetchall(self):
                return [
                    (
                        "00000000-0000-0000-0000-000000000001",
                        "Step one",
                        None,
                        "11111111-1111-1111-1111-111111111111",
                    )
                ]

        class FakeConnection:
            def __init__(self):
                self.cur = FakeCursor()
                self.commits = 0

            def cursor(self):
                return self.cur

            def commit(self):
                self.commits += 1

        conn = FakeConnection()
        module.embed_batch = lambda _texts: self.fail("embed_batch should not run")

        results = module.populate_embedding_index(
            conn,
            roles=["procedure"],
            tenant="test-tenant",
            limit=5,
            dry_run=True,
        )

        self.assertEqual(results["procedure"]["proposed"], 1)
        self.assertEqual(results["procedure"]["inserted"], 0)
        self.assertEqual(conn.commits, 0)
        self.assertIn("FROM preserve.procedure", conn.cur.executed[0][0])
        self.assertEqual(conn.cur.executed[0][1], ("test-tenant", 5))

    def test_populate_embedding_index_skips_unavailable_embed_service(self):
        module = self.load_module()

        class FakeCursor:
            def execute(self, sql, params=None):
                self.sql = sql
                self.params = params

            def fetchall(self):
                return [
                    (
                        "00000000-0000-0000-0000-000000000001",
                        "Evidence text",
                        None,
                        "11111111-1111-1111-1111-111111111111",
                    )
                ]

        class FakeConnection:
            def __init__(self):
                self.rollbacks = 0
                self.commits = 0

            def cursor(self):
                return FakeCursor()

            def rollback(self):
                self.rollbacks += 1

            def commit(self):
                self.commits += 1

        def fail_embed(_texts):
            raise module.EmbeddingBackfillError("SERVICE_UNAVAILABLE")

        conn = FakeConnection()
        module.embed_batch = fail_embed

        results = module.populate_embedding_index(
            conn,
            roles=["evidence"],
            tenant="test-tenant",
            limit=5,
            dry_run=False,
        )

        self.assertEqual(results["evidence"]["proposed"], 1)
        self.assertEqual(results["evidence"]["inserted"], 0)
        self.assertEqual(results["evidence"]["skipped_unavailable"], 1)
        self.assertEqual(conn.rollbacks, 1)
        self.assertEqual(conn.commits, 0)

    def test_insert_embedding_index_candidate_uses_384_dimension_and_conflict_guard(self):
        module = self.load_module()

        class FakeCursor:
            def __init__(self):
                self.sql = None
                self.params = None

            def execute(self, sql, params=None):
                self.sql = sql
                self.params = params

            def fetchone(self):
                return ["embedding-id"]

        class FakeConnection:
            def __init__(self):
                self.cur = FakeCursor()

            def cursor(self):
                return self.cur

        conn = FakeConnection()
        candidate = {
            "target_kind": "procedure",
            "target_column": "procedure_id",
            "vector_role": "procedure",
            "embedding_fingerprint": "fp",
            "target_id": "00000000-0000-0000-0000-000000000001",
            "source_artifact_id": None,
            "source_segment_id": "11111111-1111-1111-1111-111111111111",
            "input_sha256": "input-sha",
        }

        inserted = module.insert_embedding_index_candidate(
            conn,
            "test-tenant",
            candidate,
            [0.1, 0.2],
            "22222222-2222-2222-2222-222222222222",
        )

        self.assertTrue(inserted)
        self.assertIn("INSERT INTO preserve.embedding_index", conn.cur.sql)
        self.assertIn("embedding_dimension", conn.cur.sql)
        self.assertIn("384", conn.cur.sql)
        self.assertIn("ON CONFLICT (tenant, embedding_fingerprint) DO NOTHING", conn.cur.sql)
        self.assertEqual(conn.cur.params[1], "procedure")
        self.assertEqual(conn.cur.params[2], "procedure")
        self.assertIn("embedding_run_id", conn.cur.params[-1])
        self.assertIn("22222222-2222-2222-2222-222222222222", conn.cur.params[-1])

    def test_rollback_embedding_index_run_is_bounded_by_run_id_and_tenant(self):
        module = self.load_module()

        class FakeCursor:
            def __init__(self):
                self.executions = []
                self.fetchone_rows = [(3,)]
                self.fetchall_rows = [[("embedding-1",), ("embedding-2",)]]

            def execute(self, sql, params=None):
                self.executions.append((sql, params))

            def fetchone(self):
                return self.fetchone_rows.pop(0)

            def fetchall(self):
                return self.fetchall_rows.pop(0)

        class FakeConnection:
            def __init__(self):
                self.cur = FakeCursor()
                self.commits = 0

            def cursor(self):
                return self.cur

            def commit(self):
                self.commits += 1

        conn = FakeConnection()

        result = module.rollback_embedding_index_run(
            conn,
            tenant="test-tenant",
            embedding_run_id="22222222-2222-2222-2222-222222222222",
            limit=2,
            dry_run=False,
        )

        self.assertEqual(result, {"proposed": 2, "deleted": 2})
        self.assertEqual(conn.commits, 1)
        self.assertIn("embedding_meta->>'embedding_run_id'", conn.cur.executions[1][0])
        self.assertIn("LIMIT %s", conn.cur.executions[1][0])
        self.assertEqual(
            conn.cur.executions[1][1],
            ("test-tenant", "22222222-2222-2222-2222-222222222222", 2),
        )

    def test_rollback_embedding_index_cli_requires_embedding_index_mode(self):
        module = self.load_module()
        connected = False

        def fake_connect(_dsn):
            nonlocal connected
            connected = True
            return None

        old_argv = sys.argv
        module.psycopg.connect = fake_connect
        sys.argv = [
            "backfill-embeddings.py",
            "--rollback-embedding-run-id",
            "22222222-2222-2222-2222-222222222222",
            "--dry-run",
        ]
        try:
            with self.assertRaises(SystemExit) as raised:
                module.main()
        finally:
            sys.argv = old_argv

        self.assertEqual(raised.exception.code, 2)
        self.assertFalse(connected)


if __name__ == "__main__":
    unittest.main()
