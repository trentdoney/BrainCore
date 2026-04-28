#!/usr/bin/env python3
"""CI merge gate: bind every numeric claim in README.md to an evidence row.

The gate enforces three invariants in order:

1. **YAML rows resolve to source.** Every row in
   ``claims-to-evidence.yaml`` loads its declared source (JSON / SQL /
   file) and resolves the referenced value. Rows marked
   ``broken: true`` are SKIPPED here until the corresponding data is
   available.

2. **Every README numeric claim binds to a specific YAML row.** The
   README is scanned for claim-specific regex patterns derived from
   each YAML row's ``claim`` label (see ``CLAIM_BINDERS``). When a
   pattern matches, the captured README number is compared against the
   row's resolved source value within tolerance. If the README value
   and the source value disagree, the gate fails.

3. **Disabled rows may not back live README claims.** A row
   with ``broken: true`` whose claim-specific pattern matches the
   README fails HARD - the corresponding production-corpus data must be
   available before any launch README can cite those numbers.

The per-claim binder pattern is the machine-enforced half of the
framing story: a verifier that only checked "some unit
is covered" can be fooled by a README that cites the wrong number; a
verifier that binds README-number ↔ YAML-claim ↔ source-value cannot.

Usage::

    # Real run against a checked-out repo
    python benchmarks/verify_claims_to_evidence.py \\
        --readme README.md \\
        --claims benchmarks/claims-to-evidence.yaml

    # Self-test against a baked-in fixture (no repo needed)
    python benchmarks/verify_claims_to_evidence.py --self-test

Exits 0 on all-green, 1 on any mismatch (with a diff printed to stderr),
2 on hard error (bad YAML, missing file, malformed source JSON).

A surface-level README extractor also reports any bare numeric claim
whose unit is not covered by ANY YAML claim-binder, so dangling
README numbers cannot ship silently.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent

# Numeric-claim regex. Captures:
#   1) the numeric token (int or decimal, optional thousands separators)
#   2) a unit or category keyword
# Categories: ms, seconds, facts, entities, queries, %, "published memories"
#
# Notes on the design:
# - Longer multi-word alternatives come first in the alternation so
#   "canonical queries" wins over bare "queries".
# - Whitespace within multi-word alternatives uses `\s+` so a line
#   break between "canonical" and "queries" still matches.
# - "%" is NOT `\b`-terminated because `\b` requires a transition
#   between word and non-word characters, and "%" is non-word.
#   We post-terminate with a non-word lookahead that also allows end
#   of string.
# - The `-table\s+preserve\s+schema` alternation catches the hyphenated
#   public phrasing "13-table preserve schema" / "38-table preserve
#   schema". The hyphen is NOT a word boundary in the bare regex, so
#   without an explicit alternation `\b13\s*tables?` would never see
#   `13-table` (the digit-then-letter side of the hyphen is fine, but
#   `tables?` matches the singular `table`, not `-table`). Captured
#   unit is normalized to "preserve tables" in extract_readme_claims so
#   it lands under the existing preserve-tables binder.
NUMERIC_PATTERN = re.compile(
    r"\b(\d+(?:,\d{3})*(?:\.\d+)?)\s*"
    r"("
    r"-table\s+preserve\s+schema|"
    r"canonical\s+queries|published\s+memories|preserve\s+tables?|"
    r"milliseconds?|seconds?|facts?|entities|queries|memories|"
    r"tables?|parsers?|streams?|ms|%"
    r")"
    r"(?!\w)",
    re.IGNORECASE,
)


def extract_readme_claims(readme_text: str) -> list[tuple[str, str]]:
    """Return a list of ``(number_str, unit)`` tuples found in README text.

    Duplicates are preserved so the caller can detect cases where the
    same value is mentioned twice with divergent surrounding context.

    The hyphenated form ``13-table preserve schema`` is normalized to
    the canonical unit token ``preserve tables`` so it routes through
    the same claim-binder as the bare ``13 preserve tables`` form.
    """
    claims: list[tuple[str, str]] = []
    for match in NUMERIC_PATTERN.finditer(readme_text):
        number = match.group(1)
        # Normalize internal whitespace (newlines, repeated spaces) so
        # multi-word units like "canonical queries" compare cleanly
        # whether or not a line-break separated the words in source.
        unit = re.sub(r"\s+", " ", match.group(2).lower()).strip()
        # Hyphenated form ("-table preserve schema") collapses to the
        # canonical "preserve tables" unit so dangling-number coverage
        # and binder lookups treat both phrasings identically.
        if unit == "-table preserve schema":
            unit = "preserve tables"
        claims.append((number, unit))
    return claims


# ---------------------------------------------------------------------------
# Per-claim README binders.
#
# For every YAML claim label, a ``ClaimBinder`` defines:
#   pattern: a compiled regex over README text that localizes the claim
#            (e.g. the word "P50" followed shortly by "<number> ms"),
#            with capture group 1 = the README numeric value
#   unit:    the bare unit token that the surface-level extractor would
#            tag on the captured number (e.g. "ms", "facts") — used by
#            the dangling-number check so the README extractor reports
#            only numbers that are not covered by ANY claim-binder
#
# A YAML claim label with no registered binder is treated as "not
# README-bound" — its source value is still verified, but the README is
# not asked whether it cites that claim. Structural rows like
# "optional graph-path retrieval" (a source-file presence check) correctly
# live in this tier.
#
# To add a new claim: add a ClaimBinder row here, bind it by lowercasing
# the YAML claim label as the dict key, and make sure the extractor's
# unit alternation already covers the same unit token.
# ---------------------------------------------------------------------------


class ClaimBinder:
    __slots__ = ("pattern", "unit")

    def __init__(self, pattern: re.Pattern[str], unit: str) -> None:
        self.pattern = pattern
        self.unit = unit


def _latency_binder(pctl: str) -> ClaimBinder:
    """Binder for 'P50 latency' style claims — looks for P<pctl> within a
    short window of a <number> ms token.
    """
    return ClaimBinder(
        re.compile(
            rf"\bP{pctl}\b[^\n]{{0,60}}?(\d+(?:\.\d+)?)\s*ms\b",
            re.IGNORECASE,
        ),
        "ms",
    )


def _count_binder(keyword: str, unit: str) -> ClaimBinder:
    """Binder for 'N <keyword>' style claims — keyword must follow number
    within a single line. Used for facts / entities / tables / parsers /
    canonical queries.
    """
    return ClaimBinder(
        re.compile(
            rf"\b(\d+(?:,\d{{3}})*(?:\.\d+)?)\s+{keyword}\b",
            re.IGNORECASE,
        ),
        unit,
    )


def _percent_binder(label_regex: str) -> ClaimBinder:
    """Binder for '...label... N%' style claims — label_regex is a
    substring regex that must precede the number/percent within a short
    window. Used for grounding rate and relevance at 10. Lazy-quantifies
    every skip so the first number after the label is captured, not a
    fractional tail after a greedy skip.
    """
    return ClaimBinder(
        re.compile(
            # Lazy [^\n]{0,80} so the first digits after label are captured.
            rf"{label_regex}[^\n]{{0,80}}?(\d+(?:\.\d+)?)\s*%",
            re.IGNORECASE,
        ),
        "%",
    )


def _preserve_tables_binder() -> ClaimBinder:
    """Binder for the preserve-schema table-count claim. Catches BOTH
    public phrasings:

    1. ``N preserve tables``           — bare cardinal form
    2. ``N-table preserve schema``     — hyphenated public phrasing

    Both yield capture group 1 = the README numeric value, and the unit
    is the canonical ``preserve tables`` token. The hyphenated form must
    be matched explicitly because the surface NUMERIC_PATTERN's
    `\\s*tables?` segment treats `-` as outside the alternation. This
    binder is used for `13-table preserve schema` and any future row
    that asserts a specific preserve-table count.
    """
    return ClaimBinder(
        re.compile(
            r"\b(\d+(?:,\d{3})*(?:\.\d+)?)"
            r"(?:\s+preserve\s+tables?\b|\s*-\s*table\s+preserve\s+schema\b)",
            re.IGNORECASE,
        ),
        "preserve tables",
    )


CLAIM_BINDERS: dict[str, ClaimBinder] = {
    "p50 latency": _latency_binder("50"),
    "p95 latency": _latency_binder("95"),
    "p99 latency": _latency_binder("99"),
    "production p50 latency": _latency_binder("50"),
    "production p95 latency": _latency_binder("95"),
    "production p99 latency": _latency_binder("99"),
    "facts in preserve corpus": _count_binder("facts?", "facts"),
    "production corpus facts": _count_binder("facts?", "facts"),
    "entities in preserve corpus": _count_binder("entities", "entities"),
    # Unit tokens MUST match what extract_readme_claims() emits — the
    # extractor normalizes multi-word units like "published memories"
    # and "canonical queries" to lowercase single-space strings.
    "published memories": _count_binder("published\\s+memories?", "published memories"),
    "canonical queries": _count_binder("canonical\\s+queries", "canonical queries"),
    # Hyphen-aware preserve-tables binder catches both "13 preserve
    # tables" and "13-table preserve schema". Used for both the smoke
    # row (expected: 13) and the current production row (expected: 38).
    "13-table preserve schema": _preserve_tables_binder(),
    "38-table preserve schema": _preserve_tables_binder(),
    "9 deterministic parsers": _count_binder("deterministic\\s+parsers?", "parsers"),
    # Both relevance_at_10 and grounding_rate are reported as decimal
    # fractions in the smoke JSONs (0.4167, 0.5556). If the README cites
    # them it will most likely be as "41.67%" / "55.56%" or "0.4167" —
    # we bind on the percent form. The percent binder's lazy
    # [^\n]{0,80}? handles any intermediate prose between the label and
    # the number, so the label here can be a bare keyword.
    "relevance at 10": _percent_binder(r"relevance"),
    "smoke fact-evidence coverage": _percent_binder(r"grounding"),
    "production grounding rate": _percent_binder(r"grounding"),
}


# ---------------------------------------------------------------------------
# Framing-anchor isolation: closes the smoke vs production false-positive
# class identified in smoke-vs-production binder review. The same regex (e.g. "N facts") is
# used by both `facts in preserve corpus` (smoke) and `production corpus
# facts` (production). Without an anchor, a smoke README mention of "9
# facts" would also bind to the production row and trigger the broken
# disabled-row hard-fail.
#
# Solution: production-corpus rows REQUIRE a production-anchor word
# ("production", "deployment", "live") within a window
# around the README match. Smoke-regression rows have NO anchor
# requirement — smoke is the default framing for any README claim
# that does not explicitly call itself out as production.
#
# This way, "9 facts in the corpus" binds ONLY to the smoke row, and
# "26,966 facts in the production corpus" binds ONLY to the production
# row. A README cannot accidentally trigger a production claim with a
# smoke value, and a smoke claim cannot leak into a production row.
# ---------------------------------------------------------------------------

PRODUCTION_ANCHOR_RE = re.compile(
    r"\b(production|deployment|live)\b",
    re.IGNORECASE,
)
# Sentence-boundary regex: a period/!/? followed by whitespace, OR
# a paragraph break, OR start/end of string. Used to clip the
# anchor-search window to the same sentence as the cited number, so a
# production claim three sentences down does not leak into a smoke
# claim's framing window.
SENTENCE_BOUNDARY_RE = re.compile(r"(?:[.!?](?=\s)|\n\s*\n)")


def _sentence_around(readme_text: str, match: re.Match[str]) -> str:
    """Return the sentence (or short paragraph) containing the match.

    Uses simple sentence-boundary heuristics: backwards-scan from
    match.start() to the previous sentence boundary, forwards-scan from
    match.end() to the next sentence boundary. The returned slice
    excludes the boundaries themselves. This is the lexical scope used
    by the framing-anchor filter so a production-anchor word in a
    different sentence cannot leak into a smoke claim (or vice versa).
    """
    pre = readme_text[: match.start()]
    post = readme_text[match.end() :]
    # Find last boundary in pre (search from the end backwards).
    pre_boundaries = list(SENTENCE_BOUNDARY_RE.finditer(pre))
    pre_start = pre_boundaries[-1].end() if pre_boundaries else 0
    # Find first boundary in post.
    post_boundary = SENTENCE_BOUNDARY_RE.search(post)
    post_end = (
        match.end() + post_boundary.start() if post_boundary else len(readme_text)
    )
    return readme_text[pre_start:post_end]


def _framing_anchor_satisfied(
    framing: str,
    match: re.Match[str],
    readme_text: str,
) -> bool:
    """Return True if the README match satisfies the framing's anchor.

    Symmetric, sentence-scoped framing isolation:

    - ``production-corpus`` rows: the SAME SENTENCE as the match MUST
      contain at least one of the production-anchor words
      (production/deployment/live).
    - ``smoke-regression`` rows: the SAME SENTENCE as the match MUST
      NOT contain a production-anchor word. This rejects the smoke
      binder from accidentally binding to a README citation that is
      talking about the production corpus.

    The sentence-scoped contract is stricter than a fixed-character
    window: a 120-char window can leak across sentence boundaries when
    a smoke clause and a production clause sit close together.
    Sentence-scoping ensures each citation binds only to the row whose
    framing matches the SAME clause, never an adjacent clause. This
    closes the smoke-vs-production false-positive class identified in
    smoke-vs-production binder review even when the README places both phrasings in close
    proximity (the canonical schema-evolution paragraph).
    """
    sentence = _sentence_around(readme_text, match)
    has_production_anchor = bool(PRODUCTION_ANCHOR_RE.search(sentence))

    if framing == "production-corpus":
        return has_production_anchor
    # smoke-regression (and any other framing) = production anchor MUST
    # NOT be present in the sentence.
    return not has_production_anchor


# Units covered by at least one binder — used by the dangling-number
# check to report README numerics whose unit is in the surface regex
# but is not bound by any claim.
def _binder_units() -> set[str]:
    return {b.unit for b in CLAIM_BINDERS.values()}


def find_readme_citations(
    claim_label: str,
    readme_text: str,
    framing: str = "smoke-regression",
) -> list[tuple[str, re.Match[str]]]:
    """Return all README citations for a given YAML claim label.

    Each element is ``(captured_number_str, match_object)``. An empty
    list means the README does not cite this claim.

    The optional ``framing`` argument enforces lexical isolation
    between smoke and production binders. ``production-corpus`` rows
    only return matches whose surrounding window contains a
    production-anchor word; ``smoke-regression`` rows return all
    binder matches. See ``_framing_anchor_satisfied`` for the contract.
    """
    binder = CLAIM_BINDERS.get(claim_label.strip().lower())
    if binder is None:
        return []
    return [
        (m.group(1), m)
        for m in binder.pattern.finditer(readme_text)
        if _framing_anchor_satisfied(framing, m, readme_text)
    ]


def dangling_readme_numbers(
    readme_claims: list[tuple[str, str]],
    yaml_claims: list[dict[str, Any]],
) -> list[str]:
    """Report README numeric claims whose unit has no binder coverage.

    This is the surface-level check — it does not find value mismatches,
    only units that have no claim-binder at all. A dangling unit means
    the README is citing a number that cannot be audited by the gate.
    """
    registered_labels = {str(e.get("claim", "")).strip().lower() for e in yaml_claims}
    # A YAML claim is "actively bound" when both the CLAIM_BINDERS
    # registry has a binder AND the YAML file has a row with that label.
    active_units = {
        b.unit
        for label, b in CLAIM_BINDERS.items()
        if label in registered_labels
    }

    errors: list[str] = []
    for number, unit in readme_claims:
        if unit not in active_units:
            errors.append(
                f"README cites '{number} {unit}' but no claims-to-evidence.yaml "
                f"row has an active claim-binder for unit '{unit}'. Either add "
                f"a YAML row + ClaimBinder, or drop the README number."
            )
    return errors


def parse_number(raw: str) -> float:
    return float(raw.replace(",", ""))


def load_claims_yaml(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        raise FileNotFoundError(f"claims-to-evidence.yaml not found: {path}")
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or []
    if not isinstance(data, list):
        raise ValueError(f"{path}: expected top-level list, got {type(data).__name__}")
    return data


def resolve_json_path(data: Any, dotted: str) -> Any:
    """Walk a dotted path into a JSON-shaped object.

    Example: ``latency_ms.p50`` against ``{"latency_ms": {"p50": 22.5}}``
    returns ``22.5``. Raises ``KeyError`` on missing segments.
    """
    cur: Any = data
    for segment in dotted.split("."):
        if isinstance(cur, dict) and segment in cur:
            cur = cur[segment]
        else:
            raise KeyError(f"path segment '{segment}' not found in {cur!r}")
    return cur


def values_match(actual: Any, expected: Any, tolerance: float | None) -> bool:
    """Numeric comparison with optional tolerance; string fallback otherwise."""
    if expected is None:
        # ``expected: null`` means "whatever the source currently has is fine";
        # the entry only serves to bind the claim to a source. That is the
        # Default for benchmark-derived values whose ground truth
        # is the JSON file itself.
        return actual is not None
    try:
        a = float(actual)
        e = float(expected)
    except (TypeError, ValueError):
        return actual == expected
    if tolerance is None:
        tolerance = 0.0
    return abs(a - e) <= tolerance


def _bind_readme_to_actual(
    claim: str,
    framing: str,
    actual: Any,
    tolerance: float | None,
    readme_text: str,
) -> tuple[bool, str | None]:
    """Compare README citations of ``claim`` against the resolved source
    value ``actual`` within ``tolerance``.

    Returns ``(ok, error_message)``. ``ok`` is True on agreement (or no
    citations found), False on README-vs-source disagreement. The
    error_message is None on success.

    Used by every numeric source_type branch (json, sql_query,
    file_lines, literal-numeric) so the "every README number traces to
    a source AND matches it" invariant is uniformly enforced — not just
    for JSON-backed rows.
    """
    citations = find_readme_citations(claim, readme_text, framing)
    if not citations:
        return True, None

    binder = CLAIM_BINDERS.get(claim.strip().lower())
    for cited_str, _match in citations:
        try:
            cited_num = parse_number(cited_str)
        except ValueError:
            return False, (
                f"{claim}: README cites unparseable value '{cited_str}' "
                f"(source={actual})"
            )
        # relevance_at_10 and grounding_rate are stored as decimal
        # fractions (0.4167) but cited as percents (41.67%). Normalize
        # by matching magnitude: if actual <= 1 and the binder unit is
        # "%", scale actual up by 100.
        try:
            cmp_actual = float(actual)
        except (TypeError, ValueError):
            return False, (
                f"{claim}: source resolves to non-numeric value {actual!r}, "
                f"cannot compare against README citation '{cited_str}'."
            )
        if (
            binder is not None
            and binder.unit == "%"
            and isinstance(actual, (int, float))
            and 0.0 <= cmp_actual <= 1.0
        ):
            cmp_actual = cmp_actual * 100.0
            # Widen tolerance proportionally for the percent form.
            cmp_tolerance = (tolerance or 0.0) * 100.0 + 0.01
        else:
            cmp_tolerance = tolerance if tolerance is not None else 0.0
        if abs(cited_num - cmp_actual) > cmp_tolerance:
            return False, (
                f"{claim}: README cites '{cited_str}' but source "
                f"resolves to {actual} (tolerance={tolerance}). "
                f"README and source disagree."
            )
    return True, None


def verify_claim(
    entry: dict[str, Any],
    repo_root: Path,
    cached_json: dict[Path, Any],
    readme_text: str | None = None,
) -> tuple[bool, str]:
    """Verify a single claim row from the YAML.

    Returns ``(ok, message)``. ``ok`` is True on pass, False on fail.

    For rows with a registered ClaimBinder and a non-empty ``readme_text``:
    find all README citations of this claim (filtered by framing
    anchor — production-corpus rows require a production-anchor word in
    the surrounding window), and for each, compare the captured number
    against the resolved source value within tolerance. A README-cited
    claim whose README number diverges from the source value fails HARD.

    README-value binding now applies to ``json``, ``sql_query``,
    ``file_lines``, and numeric ``literal`` source_types — not just
    ``json``. This closes smoke-vs-production binder review Gap 2 ("numeric structural rows
    not README-bound").

    Rows marked ``broken: true``:
      - If ANY framing-filtered ClaimBinder match hits the README, fail
        HARD ("disabled row cited by README").
      - Otherwise SKIP (return ok=True with a SKIP message).
    """
    source_type = entry.get("source_type", "json")
    claim = entry.get("claim", "?")
    framing = entry.get("framing", "smoke-regression")

    # Broken rows: only skip-unless-cited. Citation detection is now
    # claim-SPECIFIC via the binder regex AND framing-filtered, so a
    # smoke "9 facts" mention does NOT trigger a production "production
    # corpus facts" broken row unless the README also has a production
    # anchor in the surrounding window.
    if entry.get("broken") is True:
        citations = (
            find_readme_citations(claim, readme_text, framing)
            if readme_text
            else []
        )
        if citations:
            numbers = ", ".join(n for n, _ in citations)
            return False, (
                f"{claim}: disabled row is referenced by README "
                f"(cited values: {numbers}). Resolve the production-corpus "
                f"data before any launch README can cite this claim "
                f"(framing={framing})."
            )
        return True, (
            f"{claim}: SKIP (disabled row, framing={framing}, not cited by README)"
        )

    if source_type == "json":
        source = repo_root / entry["source"]
        if source not in cached_json:
            if not source.is_file():
                return False, f"{claim}: source missing at {source}"
            with source.open("r", encoding="utf-8") as fh:
                cached_json[source] = json.load(fh)
        data = cached_json[source]
        try:
            actual = resolve_json_path(data, entry["json_path"])
        except KeyError as exc:
            return False, f"{claim}: {exc}"
        tolerance = entry.get("tolerance")
        if not values_match(actual, entry.get("expected"), tolerance):
            return False, (
                f"{claim}: actual={actual} expected={entry.get('expected')} "
                f"tolerance={tolerance}"
            )
        if readme_text is not None:
            ok, err = _bind_readme_to_actual(
                claim, framing, actual, tolerance, readme_text
            )
            if not ok:
                return False, err
        return True, f"{claim}: OK (actual={actual})"

    if source_type == "sql_query":
        # Default: we do not execute live SQL from this gate
        # (the benchmark runners and migration tests already validated
        # the count). When the row
        # carries a numeric ``expected``, we now bind that value
        # against any README citation via the claim binder. This is
        # Option (b) — compare README literal vs YAML expected, no DB
        # required at gate time. If the row needs live SQL execution
        # in the future, set source_type=sql_query_live (not yet
        # implemented).
        expected = entry.get("expected")
        tolerance = entry.get("tolerance")
        if expected is None:
            return True, (
                f"{claim}: OK (sql_query row — no expected value, "
                f"validated by migration tests)"
            )
        if readme_text is not None:
            ok, err = _bind_readme_to_actual(
                claim, framing, expected, tolerance, readme_text
            )
            if not ok:
                return False, err
        return True, (
            f"{claim}: OK (sql_query row, expected={expected}, "
            f"README-bound)"
        )

    if source_type == "file_contains":
        source = repo_root / entry["source"]
        needle = entry.get("needle", "")
        if not source.is_file():
            return False, f"{claim}: source missing at {source}"
        text = source.read_text(encoding="utf-8", errors="replace")
        if needle in text:
            return True, f"{claim}: OK (found '{needle}')"
        return False, f"{claim}: needle '{needle}' not found in {source}"

    if source_type == "file_lines":
        base = repo_root / entry["source"]
        glob_pat = entry.get("glob", "*")
        if not base.is_dir():
            return False, f"{claim}: source dir missing at {base}"
        count = sum(1 for _ in base.glob(glob_pat))
        tolerance = entry.get("tolerance")
        if not values_match(count, entry.get("expected"), tolerance):
            return False, (
                f"{claim}: found {count} files matching {glob_pat}, "
                f"expected {entry.get('expected')}"
            )
        # smoke-vs-production binder review Gap 2 fix: file_lines rows are now README-value-
        # bound. The resolved file count must agree with any README
        # citation via the claim binder.
        if readme_text is not None:
            ok, err = _bind_readme_to_actual(
                claim, framing, count, tolerance, readme_text
            )
            if not ok:
                return False, err
        return True, f"{claim}: OK ({count} files matching {glob_pat})"

    if source_type == "literal":
        # literal-claim verification fix: implement the documented `literal`
        # source_type. Two modes:
        #
        # 1. String-literal mode (expected is a non-numeric string):
        #    the README must contain the exact ``expected`` substring.
        #    No file lookup, no JSON parse — pure README presence
        #    check. Used for invariant phrases like
        #    "PostgreSQL 15+ (tested on 16)".
        #
        # 2. Numeric-literal mode (expected is int/float):
        #    treat the YAML row as the source of truth and bind any
        #    README citations of the claim against the expected
        #    numeric value, just like sql_query. Used when the claim
        #    is a fixed structural number with no live source.
        expected = entry.get("expected")
        if expected is None:
            return False, (
                f"{claim}: literal row missing required 'expected' field"
            )
        if isinstance(expected, str):
            if readme_text is None:
                return True, (
                    f"{claim}: OK (literal row, no README provided)"
                )
            if expected in readme_text:
                return True, f"{claim}: OK (literal phrase present)"
            return False, (
                f"{claim}: literal phrase '{expected}' not found in README"
            )
        # Numeric literal: bind via claim binder.
        tolerance = entry.get("tolerance")
        if readme_text is not None:
            ok, err = _bind_readme_to_actual(
                claim, framing, expected, tolerance, readme_text
            )
            if not ok:
                return False, err
        return True, (
            f"{claim}: OK (literal numeric, expected={expected}, "
            f"README-bound)"
        )

    return False, f"{claim}: unknown source_type '{source_type}'"


def verify_all(
    claims: list[dict[str, Any]],
    repo_root: Path,
    readme_text: str | None = None,
) -> tuple[int, int, list[str]]:
    cached_json: dict[Path, Any] = {}
    passed = 0
    failed = 0
    messages: list[str] = []
    for entry in claims:
        ok, msg = verify_claim(entry, repo_root, cached_json, readme_text)
        messages.append(msg)
        if ok:
            passed += 1
        else:
            failed += 1
    return passed, failed, messages


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

_FIXTURE_README = """\
# BrainCore

BrainCore runs on a 13-table preserve schema with a P50 latency of
22.5 ms. The corpus has 42 facts and 17 entities across 12 canonical
queries. Evidence grounding currently sits at 75.0%.
"""

_FIXTURE_CLAIMS_YAML = """\
- claim: "P50 latency"
  source: "results/retrieval.json"
  source_type: "json"
  json_path: "latency_ms.p50"
  expected: 22.5
  tolerance: 0.5
  framing: "smoke-regression"

- claim: "facts in preserve corpus"
  source: "results/retrieval.json"
  source_type: "json"
  json_path: "corpus.facts"
  expected: 42
  tolerance: 0
  framing: "smoke-regression"

- claim: "entities in preserve corpus"
  source: "results/retrieval.json"
  source_type: "json"
  json_path: "corpus.entities"
  expected: 17
  tolerance: 0
  framing: "smoke-regression"

- claim: "canonical queries"
  source: "results/retrieval.json"
  source_type: "json"
  json_path: "quality.canonical_queries"
  expected: 12
  tolerance: 0
  framing: "smoke-regression"

- claim: "smoke fact-evidence coverage"
  source: "results/grounding.json"
  source_type: "json"
  json_path: "grounding_rate"
  expected: 0.75
  tolerance: 0.01
  framing: "smoke-regression"

- claim: "13-table preserve schema"
  source: "pg_tables"
  source_type: "sql_query"
  query: "SELECT count(*) FROM pg_tables WHERE schemaname='preserve'"
  expected: 13
  framing: "smoke-regression"
"""

_FIXTURE_RETRIEVAL_JSON = {
    "date": "2026-04-09",
    "version": "1.1.5",
    "corpus": {"facts": 42, "entities": 17, "published_memories": 3},
    "latency_ms": {"p50": 22.5, "p95": 25.3, "p99": 27.1},
    "quality": {"relevance_at_10": 1.0, "canonical_queries": 12},
}

_FIXTURE_GROUNDING_JSON = {
    "date": "2026-04-09",
    "version": "1.1.5",
    "grounding_rate": 0.75,
    "total_cases": 4,
    "grounded_cases": 3,
}


def _run_self_test() -> int:
    errors = 0

    # --- Test 1: README claim extraction ---
    claims_in_readme = extract_readme_claims(_FIXTURE_README)
    units_found = {u for _, u in claims_in_readme}
    required_units = {"ms", "facts", "entities", "canonical queries", "%"}
    missing = required_units - units_found
    if missing:
        print(f"FAIL test 1: README extraction missed units {missing}", file=sys.stderr)
        print(f"  extracted: {claims_in_readme}", file=sys.stderr)
        errors += 1
    else:
        print(f"PASS test 1: README numeric extraction (found {len(claims_in_readme)} claims)")

    # --- Test 2: end-to-end verify against fixture files (all green) ---
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        (repo / "results").mkdir(parents=True)
        (repo / "results" / "retrieval.json").write_text(
            json.dumps(_FIXTURE_RETRIEVAL_JSON), encoding="utf-8"
        )
        (repo / "results" / "grounding.json").write_text(
            json.dumps(_FIXTURE_GROUNDING_JSON), encoding="utf-8"
        )
        claims_path = repo / "claims.yaml"
        claims_path.write_text(_FIXTURE_CLAIMS_YAML, encoding="utf-8")

        claims = load_claims_yaml(claims_path)
        passed, failed, messages = verify_all(claims, repo)
        if failed != 0:
            print("FAIL test 2: expected 0 failures, got:", file=sys.stderr)
            for m in messages:
                print(f"  {m}", file=sys.stderr)
            errors += 1
        elif passed != 6:
            print(f"FAIL test 2: expected 6 passes, got {passed}", file=sys.stderr)
            errors += 1
        else:
            print(f"PASS test 2: end-to-end verify ({passed}/6 rows green)")

    # --- Test 3: tolerance catches a drift beyond the allowed delta ---
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        (repo / "results").mkdir(parents=True)
        drifted = dict(_FIXTURE_RETRIEVAL_JSON)
        drifted["latency_ms"] = {"p50": 99.0, "p95": 25.3, "p99": 27.1}
        (repo / "results" / "retrieval.json").write_text(
            json.dumps(drifted), encoding="utf-8"
        )
        (repo / "results" / "grounding.json").write_text(
            json.dumps(_FIXTURE_GROUNDING_JSON), encoding="utf-8"
        )
        claims_path = repo / "claims.yaml"
        claims_path.write_text(_FIXTURE_CLAIMS_YAML, encoding="utf-8")
        claims = load_claims_yaml(claims_path)
        passed, failed, messages = verify_all(claims, repo)
        if failed == 0:
            print("FAIL test 3: drift of P50 22.5 -> 99.0 was not caught",
                  file=sys.stderr)
            errors += 1
        else:
            print(f"PASS test 3: tolerance caught drift ({failed} failure(s))")

    # --- Test 4: json_path resolver on nested dicts ---
    sample = {"a": {"b": {"c": 42}}}
    if resolve_json_path(sample, "a.b.c") != 42:
        print("FAIL test 4: json_path resolver", file=sys.stderr)
        errors += 1
    else:
        print("PASS test 4: json_path resolver")

    # --- Test 5: dangling README number surface-check. ---
    # Use "4 parsers" as the dangling unit: fixture YAML has no parsers
    # row, so "4 parsers" should surface as a dangling error, while the
    # other (ms / facts / entities / canonical queries / %) are all
    # covered and must not error.
    dangling_readme = (
        "BrainCore has 4 parsers listed. Also 42 facts, 17 entities, "
        "P50 of 22.5 ms, 12 canonical queries, and 75.0 %"
    )
    dangling_claims = extract_readme_claims(dangling_readme)
    fixture_claims = yaml.safe_load(_FIXTURE_CLAIMS_YAML)
    binding_errors = dangling_readme_numbers(dangling_claims, fixture_claims)
    if not binding_errors or not any(
        "parser" in e.lower() for e in binding_errors
    ):
        print(
            "FAIL test 5: dangling-number surface check did not catch "
            "'4 parsers' claim",
            file=sys.stderr,
        )
        print(f"  dangling_claims extracted: {dangling_claims}", file=sys.stderr)
        for e in binding_errors:
            print(f"  {e}", file=sys.stderr)
        errors += 1
    elif any("parser" not in e.lower() for e in binding_errors):
        # Surface check must ONLY fail on the parsers line, not on the
        # other 5 covered claims.
        print(
            "FAIL test 5: dangling-number surface check wrongly flagged a "
            "covered claim",
            file=sys.stderr,
        )
        for e in binding_errors:
            print(f"  {e}", file=sys.stderr)
        errors += 1
    else:
        print(
            f"PASS test 5: dangling-number surface check caught '4 parsers' "
            f"({len(binding_errors)} binding error(s))"
        )

    # --- Test 6: broken:true rows are SKIPPED when uncited,
    #             FAILED HARD when cited by a claim-specific binder. ---
    broken_yaml_unused = [{
        "claim": "production corpus facts",
        "source": "benchmarks/results/production.json",
        "source_type": "json",
        "json_path": "corpus.facts",
        "expected": 26966,
        "tolerance": 0,
        "framing": "production-corpus",
        "broken": True,
    }]
    # Case A: README cites "26,966 facts" inside a "production corpus"
    # context. The framing-aware binder fires (production anchor word
    # present in the surrounding window), so the disabled row
    # must FAIL HARD. This is the contract: a launch README that wants
    # to advertise a production-corpus number must wait for the
    # production-corpus JSON to ship — not silently bind to a broken
    # data. Note the production anchor word is REQUIRED here:
    # see test group 8 for the smoke-vs-production isolation case where
    # the same number with no production anchor SKIPS the broken row.
    readme_citing_facts = (
        "Our production corpus has 26,966 facts as of 2026-04-09."
    )
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        p, f, msgs = verify_all(broken_yaml_unused, repo, readme_citing_facts)
        if f != 1 or "disabled row is referenced" not in msgs[0]:
            print(
                f"FAIL test 6a: expected HARD-FAIL for cited broken row, got "
                f"pass={p} fail={f} msg={msgs}",
                file=sys.stderr,
            )
            errors += 1
        else:
            print("PASS test 6a: broken:true row FAILED HARD on binder-cited README")

    # Case B: README does not mention "facts" at all -> SKIP
    readme_no_facts = "This README talks about latency of 22 ms only."
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        p, f, msgs = verify_all(broken_yaml_unused, repo, readme_no_facts)
        if f != 0 or p != 1 or "SKIP" not in msgs[0]:
            print(
                f"FAIL test 6b: expected SKIP for uncited broken row, got "
                f"pass={p} fail={f} msg={msgs}",
                file=sys.stderr,
            )
            errors += 1
        else:
            print("PASS test 6b: broken:true row SKIPPED when README does not cite it")

    # --- Test 7: README value must MATCH source value (claim binding). ---
    # The fixture README says "42 facts" and the fixture JSON has
    # corpus.facts=42 — must pass. If we write a diverging README that
    # says "999 facts" while the JSON still has 42, the row must fail
    # HARD with a README-vs-source disagreement.
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        (repo / "results").mkdir(parents=True)
        (repo / "results" / "retrieval.json").write_text(
            json.dumps(_FIXTURE_RETRIEVAL_JSON), encoding="utf-8"
        )
        (repo / "results" / "grounding.json").write_text(
            json.dumps(_FIXTURE_GROUNDING_JSON), encoding="utf-8"
        )
        claims_path = repo / "claims.yaml"
        claims_path.write_text(_FIXTURE_CLAIMS_YAML, encoding="utf-8")
        claims = load_claims_yaml(claims_path)

        # 7a: honest README — all 6 rows pass
        passed, failed, messages = verify_all(claims, repo, _FIXTURE_README)
        if failed != 0:
            print(f"FAIL test 7a: honest README must pass, got failed={failed}",
                  file=sys.stderr)
            for m in messages:
                print(f"  {m}", file=sys.stderr)
            errors += 1
        else:
            print(f"PASS test 7a: honest README (all {passed}/6 pass)")

        # 7b: lying README — claims "999 facts" instead of 42
        lying_readme = _FIXTURE_README.replace("42 facts", "999 facts")
        passed, failed, messages = verify_all(claims, repo, lying_readme)
        lies_caught = any(
            "facts" in m.lower() and "disagree" in m.lower() for m in messages
        )
        if not lies_caught:
            print(
                "FAIL test 7b: lying README '999 facts' vs source=42 was not "
                "caught by claim-value binding",
                file=sys.stderr,
            )
            for m in messages:
                print(f"  {m}", file=sys.stderr)
            errors += 1
        else:
            print("PASS test 7b: claim-value binding caught README '999 facts' lie")

    # --- Test 8: smoke vs production binder isolation. -----------------
    # smoke-vs-production binder review Gap 1: smoke and production binders shared regex
    # patterns for facts / P50/P95 / grounding. The framing-anchor
    # filter closes that overlap. This test runs BOTH a smoke row and a
    # broken production row against two different READMEs and proves
    # each binds to exactly one row, never the other.
    smoke_and_production_yaml = [
        {
            "claim": "facts in preserve corpus",
            "source": "results/retrieval.json",
            "source_type": "json",
            "json_path": "corpus.facts",
            "expected": 9,
            "tolerance": 0,
            "framing": "smoke-regression",
        },
        {
            "claim": "production corpus facts",
            "source": "results/production.json",
            "source_type": "json",
            "json_path": "corpus.facts",
            "expected": 26966,
            "tolerance": 0,
            "framing": "production-corpus",
            "broken": True,
        },
    ]
    smoke_retrieval = {"corpus": {"facts": 9}}

    # Case 8a: smoke README mentions "9 facts" with no production
    # anchor. Smoke row must MATCH (PASS); broken production row must
    # SKIP (not hard-fail) because the production anchor is absent.
    smoke_only_readme = (
        "The synthetic smoke fixture has 9 facts wired by seed_smoke.sql."
    )
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        (repo / "results").mkdir(parents=True)
        (repo / "results" / "retrieval.json").write_text(
            json.dumps(smoke_retrieval), encoding="utf-8"
        )
        p, f, msgs = verify_all(
            smoke_and_production_yaml, repo, smoke_only_readme
        )
        smoke_msg = next((m for m in msgs if "facts in preserve corpus" in m), "")
        prod_msg = next((m for m in msgs if "production corpus facts" in m), "")
        smoke_ok = "OK" in smoke_msg
        prod_skip = "SKIP" in prod_msg
        if not (f == 0 and smoke_ok and prod_skip):
            print(
                f"FAIL test 8a: smoke README leaked into production binder, "
                f"got pass={p} fail={f}",
                file=sys.stderr,
            )
            for m in msgs:
                print(f"  {m}", file=sys.stderr)
            errors += 1
        else:
            print(
                "PASS test 8a: smoke '9 facts' citation bound only to smoke "
                "row, production broken row SKIPPED"
            )

    # Case 8b: production README mentions "26,966 facts in the
    # production corpus". Symmetric framing isolation:
    # - Smoke "facts in preserve corpus" row: production anchor present
    #   in the surrounding window → smoke binder REJECTS the match → no
    #   false-positive disagreement against the smoke value (9).
    # - Broken "production corpus facts" row: production anchor present
    #   → production binder MATCHES → broken row hard-fails as designed.
    # This proves the smoke and production rows can coexist on the same
    # binder shape without cross-triggering.
    production_only_readme = (
        "Our live production corpus contains 26,966 facts on the production "
        "deployment, captured 2026-04-09."
    )
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        (repo / "results").mkdir(parents=True)
        (repo / "results" / "retrieval.json").write_text(
            json.dumps(smoke_retrieval), encoding="utf-8"
        )
        p, f, msgs = verify_all(
            smoke_and_production_yaml, repo, production_only_readme
        )
        broken_caught = any(
            "production corpus facts" in m and "disabled row is referenced" in m
            for m in msgs
        )
        if not broken_caught:
            print(
                f"FAIL test 8b: production README citation did not trigger "
                f"broken production row, got pass={p} fail={f}",
                file=sys.stderr,
            )
            for m in msgs:
                print(f"  {m}", file=sys.stderr)
            errors += 1
        else:
            print(
                "PASS test 8b: production '26,966 facts' citation hard-failed "
                "the broken production row via framing anchor"
            )

    # Case 8c: smoke + production rows that share a binder shape but
    # disagree on the value (smoke says 13-table, production says
    # 38-table preserve schema). Both rows are non-broken sql_query
    # rows. README cites both phrasings, with the production phrasing
    # wrapped in a production-anchor sentence and the smoke phrasing
    # wrapped in a smoke-context sentence. Symmetric isolation must:
    #   - bind the smoke 13-table row to the smoke citation only,
    #   - bind the production 38-table row to the production citation
    #     only,
    #   - and result in zero failures despite both rows using the same
    #     hyphen-aware preserve-tables binder.
    smoke_and_prod_schema = [
        {
            "claim": "13-table preserve schema",
            "source": "pg_tables",
            "source_type": "sql_query",
            "expected": 13,
            "tolerance": 0,
            "framing": "smoke-regression",
        },
        {
            "claim": "38-table preserve schema",
            "source": "pg_tables",
            "source_type": "sql_query",
            "expected": 38,
            "tolerance": 0,
            "framing": "production-corpus",
        },
    ]
    coexistence_readme = (
        "The smoke regression test runs against a 13-table preserve "
        "schema (migrations 001-007 only). Our production "
        "deployment ships a 38-table preserve schema after migration 020 lands."
    )
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        p, f, msgs = verify_all(
            smoke_and_prod_schema, repo, coexistence_readme
        )
        if f != 0 or p != 2:
            print(
                f"FAIL test 8c: smoke and production preserve-schema rows "
                f"failed to coexist, got pass={p} fail={f}",
                file=sys.stderr,
            )
            for m in msgs:
                print(f"  {m}", file=sys.stderr)
            errors += 1
        else:
            print(
                "PASS test 8c: smoke 13-table and production 38-table "
                "preserve schema rows coexist via symmetric isolation"
            )

    # --- Test 9: hyphenated phrasing matcher for preserve schema. -------
    # The README uses "13-table preserve
    # schema" / "38-table preserve schema" hyphenation; the bare
    # "N preserve tables" binder missed it. The new
    # _preserve_tables_binder + NUMERIC_PATTERN extension catch BOTH
    # forms. This test uses literal source_type rows (Gap 4) to bind
    # the expected schema count without needing a JSON file.
    hyphen_yaml_13 = [{
        "claim": "13-table preserve schema",
        "source_type": "literal",
        "expected": 13,
        "tolerance": 0,
        "framing": "smoke-regression",
    }]
    hyphen_yaml_38 = [{
        "claim": "38-table preserve schema",
        "source_type": "literal",
        "expected": 38,
        "tolerance": 0,
        "framing": "smoke-regression",
    }]
    # 9a: README uses "13-table preserve schema" — should bind to 13.
    readme_13 = "BrainCore ships a 13-table preserve schema today."
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        p, f, msgs = verify_all(hyphen_yaml_13, repo, readme_13)
        if f != 0 or p != 1:
            print(
                f"FAIL test 9a: '13-table preserve schema' phrasing not "
                f"matched, got pass={p} fail={f}",
                file=sys.stderr,
            )
            for m in msgs:
                print(f"  {m}", file=sys.stderr)
            errors += 1
        else:
            print(
                "PASS test 9a: hyphenated '13-table preserve schema' bound "
                "to literal expected=13"
            )

    # 9b: README uses "38-table preserve schema" — should bind to 38.
    readme_38 = "After 020 the count rises to a 38-table preserve schema."
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        p, f, msgs = verify_all(hyphen_yaml_38, repo, readme_38)
        if f != 0 or p != 1:
            print(
                f"FAIL test 9b: '38-table preserve schema' phrasing not "
                f"matched, got pass={p} fail={f}",
                file=sys.stderr,
            )
            for m in msgs:
                print(f"  {m}", file=sys.stderr)
            errors += 1
        else:
            print(
                "PASS test 9b: hyphenated '38-table preserve schema' bound "
                "to literal expected=38"
            )

    # 9c: README LIES — says "99-table preserve schema" while YAML
    # expects 38. Must FAIL HARD on README-vs-source disagreement.
    lying_hyphen_readme = "We allegedly have a 99-table preserve schema."
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        p, f, msgs = verify_all(hyphen_yaml_38, repo, lying_hyphen_readme)
        if f != 1 or not any("disagree" in m for m in msgs):
            print(
                f"FAIL test 9c: lying '99-table preserve schema' not caught, "
                f"got pass={p} fail={f}",
                file=sys.stderr,
            )
            for m in msgs:
                print(f"  {m}", file=sys.stderr)
            errors += 1
        else:
            print(
                "PASS test 9c: hyphen-aware binder caught lying "
                "'99-table preserve schema' (expected 38)"
            )

    # 9d: bare "13 preserve tables" form still works (regression check).
    readme_bare = "Migrations 001-007 leave 13 preserve tables in place."
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        p, f, msgs = verify_all(hyphen_yaml_13, repo, readme_bare)
        if f != 0 or p != 1:
            print(
                f"FAIL test 9d: bare '13 preserve tables' form regression, "
                f"got pass={p} fail={f}",
                file=sys.stderr,
            )
            for m in msgs:
                print(f"  {m}", file=sys.stderr)
            errors += 1
        else:
            print(
                "PASS test 9d: bare '13 preserve tables' form still binds"
            )

    # --- Test 10: literal source_type handler. -------------------------
    # literal-claim verification: the YAML header documented `literal` but the
    # verifier had no handler. This test exercises the new
    # string-literal mode (exact substring presence in README).
    literal_yaml = [{
        "claim": "PostgreSQL 15+",
        "source_type": "literal",
        "expected": "PostgreSQL 15+ (tested on 16)",
        "framing": "smoke-regression",
    }]
    # 10a: README contains the exact literal — PASS.
    readme_with_literal = (
        "## Requirements\n\nBrainCore requires PostgreSQL 15+ "
        "(tested on 16) and a recent Bun runtime."
    )
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        p, f, msgs = verify_all(literal_yaml, repo, readme_with_literal)
        if f != 0 or p != 1 or "literal phrase present" not in msgs[0]:
            print(
                f"FAIL test 10a: literal source_type missed exact phrase, "
                f"got pass={p} fail={f} msg={msgs}",
                file=sys.stderr,
            )
            errors += 1
        else:
            print(
                "PASS test 10a: literal source_type bound exact "
                "'PostgreSQL 15+ (tested on 16)' phrase"
            )

    # 10b: README missing the literal — FAIL.
    readme_without_literal = (
        "BrainCore needs PostgreSQL 14 or later and runs on Linux."
    )
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        p, f, msgs = verify_all(literal_yaml, repo, readme_without_literal)
        if f != 1 or "literal phrase" not in msgs[0]:
            print(
                f"FAIL test 10b: literal source_type missed absence, "
                f"got pass={p} fail={f} msg={msgs}",
                file=sys.stderr,
            )
            errors += 1
        else:
            print(
                "PASS test 10b: literal source_type FAIL HARD when "
                "exact phrase missing from README"
            )

    # --- Test 11: sql_query rows are README-value-bound. ---------------
    # smoke-vs-production binder review Gap 2: numeric sql_query / file_lines rows were
    # documentation-only — they did NOT compare README citations to the
    # expected value. The new sql_query branch routes through
    # _bind_readme_to_actual using the YAML's `expected` as the truth
    # source (Option (b): no live DB at gate time). This test proves
    # both the honest case and the lying case.
    sql_yaml = [{
        "claim": "13-table preserve schema",
        "source": "pg_tables",
        "source_type": "sql_query",
        "query": "SELECT count(*) FROM pg_tables WHERE schemaname='preserve'",
        "expected": 13,
        "tolerance": 0,
        "framing": "smoke-regression",
    }]
    # 11a: README says "13-table preserve schema" — sql_query row's
    # expected (13) must agree with the README citation (13).
    sql_readme_honest = "BrainCore exposes a 13-table preserve schema."
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        p, f, msgs = verify_all(sql_yaml, repo, sql_readme_honest)
        if f != 0 or p != 1 or "README-bound" not in msgs[0]:
            print(
                f"FAIL test 11a: sql_query honest README not bound, "
                f"got pass={p} fail={f} msg={msgs}",
                file=sys.stderr,
            )
            errors += 1
        else:
            print(
                "PASS test 11a: sql_query row README-bound to expected=13 "
                "via claim binder (no live DB)"
            )

    # 11b: README LIES — claims "42-table preserve schema" while YAML
    # expects 13. Must FAIL HARD with README-vs-source disagreement.
    sql_readme_lying = "BrainCore allegedly ships a 42-table preserve schema."
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        p, f, msgs = verify_all(sql_yaml, repo, sql_readme_lying)
        if f != 1 or not any("disagree" in m for m in msgs):
            print(
                f"FAIL test 11b: sql_query lying README not caught, "
                f"got pass={p} fail={f} msg={msgs}",
                file=sys.stderr,
            )
            errors += 1
        else:
            print(
                "PASS test 11b: sql_query row caught lying "
                "'42-table preserve schema' (expected 13)"
            )

    # 11c: file_lines row is also README-bound. Build a fixture
    # directory with 9 *-parser.ts files and a README that cites
    # "9 deterministic parsers". Then build a lying README that says
    # "99 deterministic parsers" and confirm the gate catches it.
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        ext = repo / "src" / "extract"
        ext.mkdir(parents=True)
        for name in (
            "alpha-parser.ts", "beta-parser.ts", "gamma-parser.ts",
            "delta-parser.ts", "epsilon-parser.ts", "zeta-parser.ts",
            "eta-parser.ts", "theta-parser.ts", "iota-parser.ts",
        ):
            (ext / name).write_text("// stub", encoding="utf-8")
        file_lines_yaml = [{
            "claim": "9 deterministic parsers",
            "source": "src/extract",
            "source_type": "file_lines",
            "glob": "*-parser.ts",
            "expected": 9,
            "tolerance": 0,
            "framing": "smoke-regression",
        }]
        # Honest README cites 9 — must PASS.
        honest_readme = "BrainCore ships 9 deterministic parsers."
        p, f, msgs = verify_all(file_lines_yaml, repo, honest_readme)
        if f != 0 or p != 1:
            print(
                f"FAIL test 11c: file_lines honest README not bound, "
                f"got pass={p} fail={f} msg={msgs}",
                file=sys.stderr,
            )
            errors += 1
        else:
            print("PASS test 11c: file_lines row README-bound to count=9")

        # Lying README cites 99 — must FAIL HARD.
        lying_readme = "BrainCore ships 99 deterministic parsers."
        p, f, msgs = verify_all(file_lines_yaml, repo, lying_readme)
        if f != 1 or not any("disagree" in m for m in msgs):
            print(
                f"FAIL test 11d: file_lines lying README not caught, "
                f"got pass={p} fail={f} msg={msgs}",
                file=sys.stderr,
            )
            errors += 1
        else:
            print(
                "PASS test 11d: file_lines row caught lying "
                "'99 deterministic parsers' (count=9)"
            )

    if errors == 0:
        print("verify_claims_to_evidence self-test: PASS (11/11 test groups)")
        return 0
    print(
        f"verify_claims_to_evidence self-test: FAIL ({errors} test group(s))",
        file=sys.stderr,
    )
    return 1


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--readme",
        type=Path,
        default=REPO_ROOT / "README.md",
        help="Primary claim-surface path (default: <repo_root>/README.md); CONTRIBUTING.md is also scanned by default",
    )
    parser.add_argument(
        "--claims",
        type=Path,
        default=REPO_ROOT / "benchmarks" / "claims-to-evidence.yaml",
        help="Path to claims-to-evidence.yaml",
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=REPO_ROOT,
        help="Repository root for resolving relative source paths",
    )
    parser.add_argument("--self-test", action="store_true",
                        help="Run the baked-in fixture test suite and exit")
    args = parser.parse_args(argv)

    if args.self_test:
        return _run_self_test()

    try:
        claims = load_claims_yaml(args.claims)
    except (FileNotFoundError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    if not args.readme.is_file():
        print(f"ERROR: README not found at {args.readme}", file=sys.stderr)
        return 2

    claim_surface_paths = [args.readme]
    contributing_path = args.repo_root / "CONTRIBUTING.md"
    if args.readme == REPO_ROOT / "README.md" and contributing_path.is_file():
        claim_surface_paths.append(contributing_path)

    readme_text = "\n\n".join(
        path.read_text(encoding="utf-8", errors="replace")
        for path in claim_surface_paths
    )
    readme_claims = extract_readme_claims(readme_text)
    surfaces = ", ".join(str(path) for path in claim_surface_paths)
    print(f"Found {len(readme_claims)} numeric claim(s) in {surfaces}")

    # Dangling-number surface check: every README numeric claim must
    # correspond to a unit that is covered by at least one active
    # ClaimBinder + YAML row. This is the "no stranded README numbers"
    # half of the gate.
    binding_errors = dangling_readme_numbers(readme_claims, claims)
    for err in binding_errors:
        print(f"  BINDING ERROR: {err}", file=sys.stderr)

    # Per-row verification: every YAML row resolves its source AND,
    # if the row has a registered ClaimBinder and the README cites it,
    # the cited number must match the source within tolerance. broken:
    # true rows are SKIPPED unless the README binder-matches them.
    passed, failed, messages = verify_all(claims, args.repo_root, readme_text)
    for m in messages:
        print(f"  {m}")

    total_failed = failed + len(binding_errors)
    print(
        f"Summary: {passed} passed, {failed} claim-vs-source failed, "
        f"{len(binding_errors)} dangling README-number errors"
    )
    return 0 if total_failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
