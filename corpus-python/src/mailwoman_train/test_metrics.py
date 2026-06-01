"""Tests for the support-aware token-F1 metric (`train._token_f1`).

Layer 1 of the val-metrics honesty fix: per-tag support is reported, and `macro_f1` averages only
component labels (excludes "O") that actually occur in the val sample — so a tag the sample happens
not to contain doesn't pin F1 at 0 and drag the headline number down.
"""

from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")  # training deps (torch) aren't installed in lint-only envs

from mailwoman_train.labels import ACTIVE_BIO_LABELS, LABEL_TO_ID  # noqa: E402
from mailwoman_train.train import _token_f1  # noqa: E402

NUM = len(ACTIVE_BIO_LABELS)


def _ids(*names: str) -> torch.Tensor:
    return torch.tensor([[LABEL_TO_ID[n] for n in names]])


def test_per_tag_support_counts_b_and_i():
    true = _ids("B-locality", "I-locality", "B-region", "O")
    r = _token_f1(true.clone(), true, num_labels=NUM)
    assert r["support_tag.locality"] == 2  # B + I
    assert r["support_tag.region"] == 1
    assert r["support_tag.po_box"] == 0  # absent from the sample


def test_macro_excludes_zero_support_and_O():
    # Perfect predictions on the present component labels → macro should be exactly 1.0,
    # NOT diluted by the dozens of absent tags (po_box, cedex, …) or inflated by "O".
    true = _ids("B-locality", "I-locality", "B-region", "O")
    r = _token_f1(true.clone(), true, num_labels=NUM)
    assert abs(r["macro_f1"] - 1.0) < 1e-6


def test_zero_support_tag_with_false_positive_not_counted_in_macro():
    # Model wrongly predicts a po_box where there is none. po_box has 0 true instances (support 0),
    # so its (bad) F1 is excluded from macro; the one real tag is perfect → macro stays 1.0.
    true = _ids("B-locality", "O")
    pred = _ids("B-locality", "B-po_box")
    r = _token_f1(pred, true, num_labels=NUM)
    assert r["support_tag.po_box"] == 0
    assert abs(r["macro_f1"] - 1.0) < 1e-6


def test_imperfect_prediction_lowers_macro():
    # B-region predicted as O → region recall 0 → region F1 0, averaged with perfect locality.
    true = _ids("B-locality", "B-region")
    pred = _ids("B-locality", "O")
    r = _token_f1(pred, true, num_labels=NUM)
    assert r["support_tag.region"] == 1
    assert 0.0 < r["macro_f1"] < 1.0  # locality perfect, region zero → ~0.5


def test_empty_supported_set_returns_zero():
    # Only "O" tokens → no supported component labels → macro 0.0 (no crash).
    true = _ids("O", "O")
    r = _token_f1(true.clone(), true, num_labels=NUM)
    assert r["macro_f1"] == 0.0
