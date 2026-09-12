"""Corpus receipts: the hypothesis a recipe asserts about its own corpus, and the bytes it binds to.

A receipt names a row shape the config claims the corpus contains — a source, a country, an ordered
component sequence — and the minimum number of draws an epoch must serve it. The audit counts them
on the draw pass and RAISES when one falls short, which is the point: a recipe whose hypothesis the
corpus cannot feed trains a model that answers the question nobody asked.

The binding is what stops a passing audit from being reused. It digests the config and the corpus
MANIFEST together, so a GPU run must present a token derived from the same bytes the CPU preflight
read. A receipt audit against a different corpus is not a weaker check; it is a check of something
else.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ...config import CorpusReceiptConfig


class CorpusReceiptError(ValueError):
    """A failed receipt audit with its complete report attached for persistence."""

    def __init__(self, message: str, report: dict[str, Any]):
        super().__init__(message)
        self.report = report


def corpus_receipt_binding(config_path: Path, corpus_dir: Path) -> str:
    """Bind a passing receipt audit to the exact config and corpus manifest bytes."""
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
    """Refuse a receipt-bearing GPU run unless the CPU audit bound these bytes."""
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
    """Verify that the bound CPU audit persisted a passing report."""
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

    A malformed or orphan label RAISES rather than being skipped: a receipt counted over labels the
    reader could not parse reports a shortfall that is the reader's, not the corpus's.
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
    """Whether `expected` appears as an unbroken run in `sequence`. An empty expectation matches."""
    if not expected:
        return True
    width = len(expected)
    return any(sequence[start : start + width] == expected for start in range(len(sequence) - width + 1))


def matches_receipt(row: dict[str, Any], receipt: CorpusReceiptConfig) -> bool:
    """Whether one drawn row is an instance of the shape a receipt asserts."""
    if receipt.source is not None and row.get("source") != receipt.source:
        return False
    if receipt.country is not None and row.get("country") != receipt.country:
        return False
    return contains_contiguous(component_sequence(row.get("labels", [])), receipt.component_sequence)
