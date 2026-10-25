"""The receipt one CPU preflight writes after every pre-training audit passes, and the GPU run's check of it.

The key binds the receipt to two inputs: the sha256 of the config file's bytes, and the set of sha256s the
corpus MANIFEST lists for its files. Computing it reads the config and the MANIFEST and hashes no parquet
file, so the GPU run checks it in milliseconds. The loader still verifies each file against its manifest
sha256, through the volume's sha256 cache that the preflight filled.

A receipt is written only after every audit passed, so its presence is the pass. The GPU run refuses to
start without the token the preflight returned, a receipt file under that key, and a recorded audit list
that covers every audit the config declares.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from ..data.loader.corpus_files import manifest_files

#: Bumped when the key's inputs change, so an older receipt never satisfies a newer check.
RECEIPT_VERSION = 1


class PreflightReceiptError(RuntimeError):
    """The GPU run found no receipt matching its config and corpus."""


def config_sha256(config_path: Path) -> str:
    return hashlib.sha256(config_path.read_bytes()).hexdigest()


def manifest_file_digests(corpus_dir: Path) -> list[str]:
    """The sorted, de-duplicated sha256s the MANIFEST lists for its files and their split attributes, or raise."""
    manifest = corpus_dir / "MANIFEST.json"
    if not manifest.is_file():
        raise FileNotFoundError(f"the preflight receipt key needs {manifest}")
    entries = manifest_files(json.loads(manifest.read_text(encoding="utf-8")))
    digests: set[str] = set()
    for entry in entries:
        digest = entry.get("sha256")
        if not digest:
            raise ValueError(f"{manifest} lists {entry.get('path')} with no sha256, so no receipt can bind it")
        digests.add(str(digest))
        attribute = entry.get("split_attribute")
        if isinstance(attribute, dict) and attribute.get("sha256"):
            digests.add(str(attribute["sha256"]))
    if not digests:
        raise ValueError(f"{manifest} lists no files, so no receipt can bind it")
    return sorted(digests)


def preflight_key(config_path: Path, corpus_dir: Path) -> str:
    """The receipt key: a digest of the version, the config's sha256 and the manifest's file sha256 set."""
    digest = hashlib.sha256()
    digest.update(f"preflight-v{RECEIPT_VERSION}\n".encode())
    digest.update(f"config {config_sha256(config_path)}\n".encode())
    for file_digest in manifest_file_digests(corpus_dir):
        digest.update(f"file {file_digest}\n".encode())
    return digest.hexdigest()


def receipt_path(audit_root: Path, key: str) -> Path:
    return audit_root / f"preflight-{key}.json"


def write_receipt(
    audit_root: Path, config_path: Path, corpus_dir: Path, audits: list[str], reports: dict[str, str]
) -> str:
    """Write the receipt for audits that all passed, and return its key, which is the token the GPU run presents."""
    key = preflight_key(config_path, corpus_dir)
    body: dict[str, Any] = {
        "version": RECEIPT_VERSION,
        "key": key,
        "config": str(config_path),
        "config_sha256": config_sha256(config_path),
        "corpus_dir": str(corpus_dir),
        "manifest_file_count": len(manifest_file_digests(corpus_dir)),
        "audits": sorted(audits),
        "reports": reports,
    }
    path = receipt_path(audit_root, key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return key


def verify_receipt(audit_root: Path, config_path: Path, corpus_dir: Path, token: str, required: list[str]) -> None:
    """Raise unless ``token`` is this config and corpus's key and its receipt records every ``required`` audit."""
    if not token:
        raise PreflightReceiptError("no preflight token: run the CPU preflight before allocating a GPU")
    key = preflight_key(config_path, corpus_dir)
    if token != key:
        raise PreflightReceiptError(
            f"the preflight token {token[:12]}… was issued for other config or manifest bytes than these ({key[:12]}…)"
        )
    path = receipt_path(audit_root, key)
    try:
        body = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise PreflightReceiptError(f"the preflight receipt {path} is unreadable") from error
    if body.get("version") != RECEIPT_VERSION or body.get("key") != key:
        raise PreflightReceiptError(f"{path} is not a version-{RECEIPT_VERSION} receipt for key {key}")
    missing = sorted(set(required) - set(body.get("audits") or []))
    if missing:
        raise PreflightReceiptError(f"{path} records no pass for {missing}")
