#!/usr/bin/env python3
"""BrainCore Phase 3.5 — Retrieval Evaluation Benchmark.

Runs the canonical 12-query benchmark against the Memory search API,
measuring latency, result counts, stream contributions, relevance,
and evidence grounding.
"""
import requests
import time
import json
import statistics

BASE = "http://localhost:8900"


# ── helpers ──────────────────────────────────────────────────────────

def search(query, type_filter=None, limit=10):
    payload = {"query": query, "limit": limit}
    if type_filter:
        payload["type_filter"] = type_filter
    start = time.time()
    r = requests.post(f"{BASE}/memory/search", json=payload)
    latency = (time.time() - start) * 1000
    data = r.json()
    return data, latency


def state_at(entity, at_ts):
    start = time.time()
    r = requests.get(f"{BASE}/memory/state/{entity}", params={"at": at_ts})
    latency = (time.time() - start) * 1000
    return r.json(), latency


def timeline(entity, from_ts=None, to_ts=None):
    params = {}
    if from_ts:
        params["from_ts"] = from_ts
    if to_ts:
        params["to_ts"] = to_ts
    start = time.time()
    r = requests.get(f"{BASE}/memory/timeline/{entity}", params=params)
    latency = (time.time() - start) * 1000
    return r.json(), latency


def diff(entity, from_ts, to_ts):
    start = time.time()
    r = requests.get(
        f"{BASE}/memory/diff/{entity}",
        params={"from_ts": from_ts, "to_ts": to_ts},
    )
    latency = (time.time() - start) * 1000
    return r.json(), latency


def snippet(text, max_len=80):
    if not text:
        return "(none)"
    text = str(text).replace("\n", " ").strip()
    return text[:max_len] + "..." if len(text) > max_len else text


def relevance_check(result_data, endpoint, expect_keywords):
    """Heuristic relevance: check if top result text matches expected keywords."""
    kw = expect_keywords.lower().split()
    if endpoint == "search":
        results = result_data.get("results", [])
        if not results:
            return False, "no results"
        top = results[0]
        haystack = (
            (top.get("title") or "") + " " + (top.get("summary") or "") + " " + (top.get("scope_path") or "")
        ).lower()
        matches = sum(1 for w in kw if w in haystack)
        hit = matches >= max(1, len(kw) // 3)
        return hit, f"{matches}/{len(kw)} keywords"
    elif endpoint == "state":
        facts = result_data.get("facts", [])
        if not facts:
            return False, "no facts"
        haystack = " ".join(
            (f.get("predicate", "") + " " + str(f.get("object_value", "")))
            for f in facts[:5]
        ).lower()
        matches = sum(1 for w in kw if w in haystack)
        return matches >= 1, f"{matches}/{len(kw)} keywords"
    elif endpoint == "timeline":
        entries = result_data.get("entries", [])
        return len(entries) > 0, f"{len(entries)} entries"
    elif endpoint == "diff":
        added = len(result_data.get("added", []))
        removed = len(result_data.get("removed", []))
        changed = len(result_data.get("changed", []))
        total = added + removed + changed
        return total > 0, f"{added}A/{removed}R/{changed}C"
    return False, "unknown"


# ── benchmark queries ────────────────────────────────────────────────

QUERIES = [
    {
        "num": 1,
        "name": "Temporal state: server-a Feb 2026",
        "endpoint": "state",
        "call": lambda: state_at("server-a", "2026-02-14T00:00:00Z"),
        "expect_kw": "facts server-a feb incident remediation",
    },
    {
        "num": 2,
        "name": "Similar incident: postgres timeout",
        "endpoint": "search",
        "call": lambda: search("postgres timeout connection refused"),
        "expect_kw": "postgres connection install unresponsive",
    },
    {
        "num": 3,
        "name": "Cross-device pattern: recurring failures",
        "endpoint": "search",
        "call": lambda: search("recurring failures across multiple devices"),
        "expect_kw": "incident failure device",
    },
    {
        "num": 4,
        "name": "Config-preceded incident",
        "endpoint": "search",
        "call": lambda: search("config change before incident"),
        "expect_kw": "config change configuration",
    },
    {
        "num": 5,
        "name": "Remediation: vLLM OOM fix",
        "endpoint": "search",
        "call": lambda: search("how to fix vllm out of memory"),
        "expect_kw": "vllm oom memory swap cgroup",
    },
    {
        "num": 6,
        "name": "State diff: server-b Q1 2026",
        "endpoint": "diff",
        "call": lambda: diff("server-b", "2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z"),
        "expect_kw": "added removed changed incident",
    },
    {
        "num": 7,
        "name": "Timeline: server-a March 2026",
        "endpoint": "timeline",
        "call": lambda: timeline("server-a", "2026-03-01", "2026-04-01"),
        "expect_kw": "march server-a entries events",
    },
    {
        "num": 8,
        "name": "Service-specific: docker restart",
        "endpoint": "search",
        "call": lambda: search("docker container restart failures"),
        "expect_kw": "docker container restart compose",
    },
    {
        "num": 9,
        "name": "GPU-specific: NVIDIA driver init",
        "endpoint": "search",
        "call": lambda: search("GPU driver initialization NVIDIA"),
        "expect_kw": "gpu nvidia driver cuda",
    },
    {
        "num": 10,
        "name": "Playbook: postgres recovery",
        "endpoint": "search",
        "call": lambda: search("playbook for postgres recovery", type_filter="memory"),
        "expect_kw": "postgres playbook recovery install",
    },
    {
        "num": 11,
        "name": "Hard neg: service unreachable (multi-cause)",
        "endpoint": "search",
        "call": lambda: search("service unreachable timeout"),
        "expect_kw": "timeout unreachable connection",
    },
    {
        "num": 12,
        "name": "Hard neg: server-a Dec 2025 (vs Feb 2026)",
        "endpoint": "state",
        "call": lambda: state_at("server-a", "2025-12-01T00:00:00Z"),
        "expect_kw": "facts server-a incident",
    },
]


# ── run benchmark ────────────────────────────────────────────────────

def run_benchmark():
    results = []
    all_latencies = []

    print("=" * 100)
    print("STRATA PHASE 3.5 — RETRIEVAL EVALUATION BENCHMARK")
    print("=" * 100)
    print(f"Target: {BASE}")
    print(f"Queries: {len(QUERIES)}")
    print()

    for q in QUERIES:
        data, latency = q["call"]()
        all_latencies.append(latency)

        row = {
            "num": q["num"],
            "name": q["name"],
            "endpoint": q["endpoint"],
            "latency_ms": round(latency, 1),
            "data": data,
        }

        # Extract result counts and stream info
        if q["endpoint"] == "search":
            row["result_count"] = len(data.get("results", []))
            sc = data.get("stream_counts", {})
            row["vector"] = sc.get("vector", 0)
            row["fts"] = sc.get("fts", 0)
            row["structured"] = sc.get("structured", 0)
            row["temporal"] = sc.get("temporal", 0)
            row["api_latency_ms"] = round(data.get("query_time_ms", 0), 1)

            # Top 3 results
            top3 = []
            for r in data.get("results", [])[:3]:
                top3.append({
                    "type": r.get("object_type", "?"),
                    "title": snippet(r.get("title", ""), 60),
                    "summary": snippet(r.get("summary", ""), 80),
                    "score": round(r.get("score", 0), 6),
                    "confidence": r.get("confidence", 0),
                    "has_evidence": len(r.get("evidence", [])) > 0,
                    "scope": r.get("scope_path", ""),
                })
            row["top3"] = top3

            # Evidence grounding
            all_results = data.get("results", [])
            with_evidence = sum(1 for r in all_results if r.get("evidence"))
            row["evidence_rate"] = (
                round(with_evidence / len(all_results) * 100, 1) if all_results else 0
            )

        elif q["endpoint"] == "state":
            facts = data.get("facts", [])
            row["result_count"] = len(facts)
            row["vector"] = row["fts"] = row["structured"] = row["temporal"] = "-"
            row["api_latency_ms"] = "-"
            row["evidence_rate"] = "-"
            top3 = []
            for f in facts[:3]:
                top3.append({
                    "type": "fact",
                    "title": f.get("predicate", "?"),
                    "summary": snippet(str(f.get("object_value", "")), 80),
                    "score": "-",
                    "confidence": f.get("confidence", 0),
                    "has_evidence": False,
                    "scope": f.get("scope_path", ""),
                })
            row["top3"] = top3

        elif q["endpoint"] == "timeline":
            entries = data.get("entries", [])
            row["result_count"] = len(entries)
            row["vector"] = row["fts"] = row["structured"] = row["temporal"] = "-"
            row["api_latency_ms"] = "-"
            row["evidence_rate"] = "-"
            top3 = []
            for e in entries[:3]:
                top3.append({
                    "type": e.get("entry_type", "?"),
                    "title": snippet(e.get("description", ""), 60),
                    "summary": "",
                    "score": "-",
                    "confidence": e.get("confidence", 0),
                    "has_evidence": False,
                    "scope": "",
                })
            row["top3"] = top3

        elif q["endpoint"] == "diff":
            added = len(data.get("added", []))
            removed = len(data.get("removed", []))
            changed = len(data.get("changed", []))
            row["result_count"] = added + removed + changed
            row["vector"] = row["fts"] = row["structured"] = row["temporal"] = "-"
            row["api_latency_ms"] = "-"
            row["evidence_rate"] = "-"
            top3 = []
            for a in data.get("added", [])[:3]:
                top3.append({
                    "type": "added",
                    "title": a.get("predicate", "?"),
                    "summary": snippet(str(a.get("object_value", "")), 80),
                    "score": "-",
                    "confidence": a.get("confidence", 0),
                    "has_evidence": False,
                    "scope": "",
                })
            row["top3"] = top3

        # Relevance check
        relevant, detail = relevance_check(data, q["endpoint"], q["expect_kw"])
        row["relevant"] = relevant
        row["relevance_detail"] = detail

        results.append(row)

    # ── print summary table ──────────────────────────────────────────

    print()
    print("-" * 140)
    hdr = f"{'#':>2} | {'Query':<42} | {'Endpoint':<8} | {'Lat(ms)':>8} | {'API(ms)':>8} | {'Results':>7} | {'Vec':>4} | {'FTS':>4} | {'Str':>4} | {'Tmp':>4} | {'Evid%':>5} | {'Rel?':<5}"
    print(hdr)
    print("-" * 140)

    for r in results:
        vec = str(r.get("vector", "-"))
        fts = str(r.get("fts", "-"))
        stru = str(r.get("structured", "-"))
        tmp = str(r.get("temporal", "-"))
        api = str(r.get("api_latency_ms", "-"))
        evid = str(r.get("evidence_rate", "-"))
        rel = "YES" if r["relevant"] else "NO"

        line = f"{r['num']:>2} | {r['name']:<42} | {r['endpoint']:<8} | {r['latency_ms']:>8.1f} | {api:>8} | {r['result_count']:>7} | {vec:>4} | {fts:>4} | {stru:>4} | {tmp:>4} | {evid:>5} | {rel:<5}"
        print(line)

    print("-" * 140)

    # ── detailed top-3 per query ─────────────────────────────────────

    print()
    print("=" * 100)
    print("TOP-3 RESULTS PER QUERY")
    print("=" * 100)

    for r in results:
        print(f"\n  Q{r['num']}: {r['name']}")
        print(f"  Relevance: {'YES' if r['relevant'] else 'NO'} ({r['relevance_detail']})")
        for i, t in enumerate(r.get("top3", []), 1):
            ev = " [+evidence]" if t["has_evidence"] else ""
            print(f"    {i}. [{t['type']}] {t['title']}  (score={t['score']}, conf={t['confidence']}){ev}")
            if t["summary"]:
                print(f"       {t['summary']}")
            if t.get("scope"):
                print(f"       scope: {t['scope']}")

    # ── aggregate metrics ────────────────────────────────────────────

    print()
    print("=" * 100)
    print("AGGREGATE METRICS")
    print("=" * 100)

    search_latencies = [r["latency_ms"] for r in results if r["endpoint"] == "search"]
    all_lat = [r["latency_ms"] for r in results]

    print(f"\n  Latency (all {len(all_lat)} queries):")
    print(f"    P50:  {statistics.median(all_lat):.1f} ms")
    print(f"    P95:  {sorted(all_lat)[int(len(all_lat) * 0.95)]:.1f} ms")
    print(f"    Mean: {statistics.mean(all_lat):.1f} ms")
    print(f"    Min:  {min(all_lat):.1f} ms")
    print(f"    Max:  {max(all_lat):.1f} ms")

    if search_latencies:
        print(f"\n  Latency (search only, {len(search_latencies)} queries):")
        print(f"    P50:  {statistics.median(search_latencies):.1f} ms")
        print(f"    Mean: {statistics.mean(search_latencies):.1f} ms")

    # API-internal latency for search queries
    api_lats = [r["api_latency_ms"] for r in results if isinstance(r.get("api_latency_ms"), (int, float))]
    if api_lats:
        print(f"\n  API-internal latency (search, {len(api_lats)} queries):")
        print(f"    P50:  {statistics.median(api_lats):.1f} ms")
        print(f"    Mean: {statistics.mean(api_lats):.1f} ms")

    # Result counts
    counts = [r["result_count"] for r in results]
    print("\n  Result counts:")
    print(f"    Mean:  {statistics.mean(counts):.1f}")
    print(f"    Min:   {min(counts)}")
    print(f"    Max:   {max(counts)}")

    # Evidence grounding (search only)
    evid_rates = [r["evidence_rate"] for r in results if isinstance(r.get("evidence_rate"), (int, float))]
    if evid_rates:
        print("\n  Evidence grounding (search queries):")
        print(f"    Mean:  {statistics.mean(evid_rates):.1f}%")
        print(f"    Min:   {min(evid_rates):.1f}%")
        print(f"    Max:   {max(evid_rates):.1f}%")

    # Stream utilization
    total_vec = sum(r.get("vector", 0) for r in results if isinstance(r.get("vector"), int))
    total_fts = sum(r.get("fts", 0) for r in results if isinstance(r.get("fts"), int))
    total_str = sum(r.get("structured", 0) for r in results if isinstance(r.get("structured"), int))
    total_tmp = sum(r.get("temporal", 0) for r in results if isinstance(r.get("temporal"), int))
    total_all = total_vec + total_fts + total_str + total_tmp
    if total_all > 0:
        print("\n  Stream utilization (search queries, total candidates):")
        print(f"    Vector:     {total_vec:>5} ({total_vec/total_all*100:.1f}%)")
        print(f"    FTS:        {total_fts:>5} ({total_fts/total_all*100:.1f}%)")
        print(f"    Structured: {total_str:>5} ({total_str/total_all*100:.1f}%)")
        print(f"    Temporal:   {total_tmp:>5} ({total_tmp/total_all*100:.1f}%)")

    # Relevance
    relevant_count = sum(1 for r in results if r["relevant"])
    print("\n  Relevance:")
    print(f"    Relevant:  {relevant_count}/{len(results)} ({relevant_count/len(results)*100:.0f}%)")

    # Hard negative differentiation (Q11 vs Q2)
    print("\n  Hard negative analysis:")
    q2 = next(r for r in results if r["num"] == 2)
    q11 = next(r for r in results if r["num"] == 11)
    q2_scopes = set(t.get("scope", "") for t in q2.get("top3", []))
    q11_scopes = set(t.get("scope", "") for t in q11.get("top3", []))
    overlap = q2_scopes & q11_scopes - {""}
    print(f"    Q2 (postgres timeout) top scopes:  {q2_scopes}")
    print(f"    Q11 (service unreachable) top scopes: {q11_scopes}")
    print(f"    Overlap: {len(overlap)} scopes  -> {'GOOD differentiation' if len(overlap) <= 1 else 'WEAK differentiation'}")

    # Q11 multi-cause check
    q11_causes = set()
    for t in q11.get("top3", []):
        scope = t.get("scope", "")
        if "incident:" in scope:
            q11_causes.add(scope.split("incident:")[-1])
    print(f"    Q11 unique incidents in top-3: {len(q11_causes)} -> {'GOOD' if len(q11_causes) >= 2 else 'NEEDS IMPROVEMENT'}")
    if q11_causes:
        for c in q11_causes:
            print(f"      - {c}")

    # Hard negative: Q1 vs Q12 (same entity different time)
    q1 = next(r for r in results if r["num"] == 1)
    q12 = next(r for r in results if r["num"] == 12)
    q1_count = q1["result_count"]
    q12_count = q12["result_count"]
    print(f"\n    Q1  (server-a Feb 2026): {q1_count} facts")
    print(f"    Q12 (server-a Dec 2025): {q12_count} facts")
    diff_count = abs(q1_count - q12_count)
    pct = diff_count / max(q1_count, q12_count) * 100 if max(q1_count, q12_count) > 0 else 0
    print(f"    Difference: {diff_count} facts ({pct:.0f}%) -> {'GOOD temporal differentiation' if pct >= 5 else 'WEAK temporal differentiation'}")

    print()
    print("=" * 100)
    print("BENCHMARK COMPLETE")
    print("=" * 100)

    # ── JSON output for programmatic use ─────────────────────────────
    summary = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "query_count": len(results),
        "latency_p50_ms": round(statistics.median(all_lat), 1),
        "latency_p95_ms": round(sorted(all_lat)[int(len(all_lat) * 0.95)], 1),
        "latency_mean_ms": round(statistics.mean(all_lat), 1),
        "avg_result_count": round(statistics.mean(counts), 1),
        "evidence_grounding_pct": round(statistics.mean(evid_rates), 1) if evid_rates else None,
        "relevance_rate": round(relevant_count / len(results) * 100, 0),
        "stream_vector_pct": round(total_vec / total_all * 100, 1) if total_all else 0,
        "stream_fts_pct": round(total_fts / total_all * 100, 1) if total_all else 0,
        "stream_structured_pct": round(total_str / total_all * 100, 1) if total_all else 0,
        "stream_temporal_pct": round(total_tmp / total_all * 100, 1) if total_all else 0,
    }

    with open("./scripts/benchmark-results.json", "w") as f:
        json.dump(summary, f, indent=2)
    print("\nJSON summary written to ./scripts/benchmark-results.json")


if __name__ == "__main__":
    run_benchmark()
