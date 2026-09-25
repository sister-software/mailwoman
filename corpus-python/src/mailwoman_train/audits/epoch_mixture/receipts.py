"""Match drawn rows against corpus receipts and bind a passing audit to its input bytes.

A receipt describes a row shape that a config expects its corpus to contain. The shape can fix a
source, a country and an ordered component sequence. The receipt also sets the minimum number of
matching draws per epoch, and the audit raises when a receipt falls short.

The binding token is a digest of the config file and the corpus MANIFEST. A GPU run must present
the token from the CPU preflight, which prevents a passing audit from being reused for other bytes.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ...config import CorpusReceiptConfig


class CorpusReceiptError(ValueError):
    """Report a failed receipt audit and carry the full report so the caller can save it."""

    def __init__(self, message: str, report: dict[str, Any]):
        super().__init__(message)
        self.report = report


def corpus_receipt_binding(config_path: Path, corpus_dir: Path) -> str:
    """Return a SHA-256 digest of the config file and the corpus MANIFEST, each prefixed by its length."""
    manifest_path = corpus_dir / "MANIFEST.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"required corpus receipt binding needs {manifest_path}")
    digest = hashlib.sha256()
    for path in (config_path, manifest_path):
        contents = path.read_bytes()
        digest.update(len(contents).to_bytes(8, "big"))
        digest.update(contents)
    return digest.hexdigest()


def verify_corpus_receipt_binding(
    config_path: Path,
    corpus_dir: Path,
    required_receipts: list[CorpusReceiptConfig],
    token: str,
) -> None:
    """Raise unless `token` matches the binding for these files, when the config requires receipts."""
    if not required_receipts:
        return
    if token != corpus_receipt_binding(config_path, corpus_dir):
        raise RuntimeError(
            "required corpus receipts were not audited against these config and manifest bytes; "
            "run the CPU receipt preflight before allocating a GPU"
        )


def verify_corpus_receipt_report(
    config_path: Path,
    corpus_dir: Path,
    required_receipts: list[CorpusReceiptConfig],
    token: str,
    report_path: Path,
) -> None:
    """Raise unless the saved report records a passing audit with this binding token."""
    if not required_receipts:
        return
    verify_corpus_receipt_binding(config_path, corpus_dir, required_receipts, token)
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"required passing corpus receipt report is unreadable: {report_path}") from exc
    meta = report.get("meta", {})
    if meta.get("corpus_receipt_status") != "pass" or meta.get("corpus_receipt_binding") != token:
        raise RuntimeError(f"required corpus receipt report is not a passing audit for these bytes: {report_path}")


def component_sequence(labels: list[str]) -> list[str]:
    """Collapse BIO token labels to their ordered component-span sequence.

    A malformed or orphan label raises. Skipping it would make a parse failure look like a corpus
    shortfall.
    """
    sequence: list[str] = []
    active: str | None = None
    for label in labels:
        if label == "O":
            active = None
            continue
        if "-" not in label:
            raise ValueError(f"malformed BIO label {label!r}: expected O, B-<component>, or I-<component>")
        prefix, component = label.split("-", 1)
        if prefix not in {"B", "I"} or not component:
            raise ValueError(f"malformed BIO label {label!r}: expected O, B-<component>, or I-<component>")
        if prefix == "I" and active != component:
            raise ValueError(f"orphan BIO label {label!r}: active component is {active!r}")
        if prefix == "B":
            sequence.append(component)
        active = component
    return sequence


def contains_contiguous(sequence: list[str], expected: list[str]) -> bool:
    """Return whether `expected` appears as a contiguous run in `sequence`. An empty `expected` matches."""
    if not expected:
        return True
    width = len(expected)
    return any(sequence[start : start + width] == expected for start in range(len(sequence) - width + 1))


def matches_receipt(row: dict[str, Any], receipt: CorpusReceiptConfig) -> bool:
    """Return whether a drawn row matches the receipt's source, country and component sequence."""
    if receipt.source is not None and row.get("source") != receipt.source:
        return False
    if receipt.country is not None and row.get("country") != receipt.country:
        return False
    return contains_contiguous(component_sequence(row.get("labels", [])), receipt.component_sequence)
