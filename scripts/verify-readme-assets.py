#!/usr/bin/env python3
"""Verify active README asset hashes and image dimensions."""

from __future__ import annotations

import hashlib
import json
import struct
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "assets" / "manifest.json"


class AssetError(Exception):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def png_size(data: bytes) -> tuple[int, int]:
    if not data.startswith(b"\x89PNG\r\n\x1a\n") or data[12:16] != b"IHDR":
        raise AssetError("invalid PNG header")
    return struct.unpack(">II", data[16:24])


def jpeg_size(data: bytes) -> tuple[int, int]:
    if not data.startswith(b"\xff\xd8"):
        raise AssetError("invalid JPEG header")

    sof_markers = {
        0xC0,
        0xC1,
        0xC2,
        0xC3,
        0xC5,
        0xC6,
        0xC7,
        0xC9,
        0xCA,
        0xCB,
        0xCD,
        0xCE,
        0xCF,
    }
    offset = 2
    while offset < len(data):
        while offset < len(data) and data[offset] != 0xFF:
            offset += 1
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            break

        marker = data[offset]
        offset += 1
        if marker in (0xD8, 0xD9):
            continue
        if marker == 0xDA:
            break
        if offset + 2 > len(data):
            raise AssetError("truncated JPEG segment")

        length = int.from_bytes(data[offset : offset + 2], "big")
        if length < 2 or offset + length > len(data):
            raise AssetError("invalid JPEG segment length")
        if marker in sof_markers:
            if length < 7:
                raise AssetError("invalid JPEG SOF segment")
            height = int.from_bytes(data[offset + 3 : offset + 5], "big")
            width = int.from_bytes(data[offset + 5 : offset + 7], "big")
            return width, height
        offset += length

    raise AssetError("JPEG size marker not found")


def image_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return png_size(data)
    if data.startswith(b"\xff\xd8"):
        return jpeg_size(data)
    raise AssetError(f"unsupported image format: {path}")


def main() -> int:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    failures: list[str] = []
    seen: set[str] = set()

    for asset in manifest.get("assets", []):
        asset_failures: list[str] = []
        rel_path = asset["path"]
        if rel_path in seen:
            failures.append(f"{rel_path}: duplicate manifest entry")
            continue
        seen.add(rel_path)

        path = ROOT / rel_path
        if not path.exists():
            failures.append(f"{rel_path}: missing file")
            continue

        actual_hash = sha256(path)
        if actual_hash != asset["sha256"]:
            asset_failures.append(
                f"{rel_path}: sha256 mismatch {actual_hash} != {asset['sha256']}"
            )

        try:
            width, height = image_size(path)
        except AssetError as exc:
            failures.append(f"{rel_path}: {exc}")
            continue

        expected_size = (asset["width"], asset["height"])
        if (width, height) != expected_size:
            asset_failures.append(
                f"{rel_path}: dimension mismatch {width}x{height} != "
                f"{expected_size[0]}x{expected_size[1]}"
            )

        if asset_failures:
            failures.extend(asset_failures)
        else:
            print(f"OK {rel_path} {width}x{height} {actual_hash}")

    if failures:
        print("\nREADME asset verification failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
