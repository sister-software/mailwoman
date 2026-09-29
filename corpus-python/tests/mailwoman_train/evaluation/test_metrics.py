"""Tests for the support-aware token-F1 metric (`train._token_f1`).

Layer 1 of the val-metrics honesty fix reports per-tag support. `macro_f1` averages only
component labels (excludes "O") that actually occur in the val sample — so a tag the sample happens
not to contain doesn't pin F1 at 0 and drag the headline number down.
"""

from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")  # training deps (torch) aren't installed in lint-only envs

from mailwoman_train.evaluation.metrics import per_locale_tag_f1, token_f1  # noqa: E402
from mailwoman_train.labels import ACTIVE_BIO_LABELS, IGNORE_INDEX, LABEL_TO_ID, LOCALE_TO_ID  # noqa: E402

NUM = len(ACTIVE_BIO_LABELS)


def _ids(*names: str) -> torch.Tensor:
    return torch.tensor([[LABEL_TO_ID[n] for n in names]])


def test_per_tag_support_counts_b_and_i():
    true = _ids("B-locality", "I-locality", "B-region", "O")
    r = token_f1(true.clone(), true, num_labels=NUM)
    assert r["support_tag.locality"] == 2  # B + I
    assert r["support_tag.region"] == 1
    assert r["support_tag.po_box"] == 0  # absent from the sample


def test_macro_excludes_zero_support_and_O():
    # Perfect predictions on the present component labels → macro should be exactly 1.0 rather than diluted by the dozens of absent tags (po_box, cedex, …) or inflated by "O".
    true = _ids("B-locality", "I-locality", "B-region", "O")
    r = token_f1(true.clone(), true, num_labels=NUM)
    assert abs(r["macro_f1"] - 1.0) < 1e-6


def test_zero_support_tag_with_false_positive_not_counted_in_macro():
    # Model wrongly predicts a po_box where there is none. po_box has 0 true instances (support 0),
    # so its (bad) F1 is excluded from macro. the one real tag is perfect → macro stays 1.0.
    true = _ids("B-locality", "O")
    pred = _ids("B-locality", "B-po_box")
    r = token_f1(pred, true, num_labels=NUM)
    assert r["support_tag.po_box"] == 0
    assert abs(r["macro_f1"] - 1.0) < 1e-6


def test_imperfect_prediction_lowers_macro():
    # B-region predicted as O → region recall 0 → region F1 0, averaged with perfect locality.
    true = _ids("B-locality", "B-region")
    pred = _ids("B-locality", "O")
    r = token_f1(pred, true, num_labels=NUM)
    assert r["support_tag.region"] == 1
    assert 0.0 < r["macro_f1"] < 1.0  # locality perfect, region zero → ~0.5


def test_empty_supported_set_returns_zero():
    # Only "O" tokens → no supported component labels → macro 0.0 (no crash).
    true = _ids("O", "O")
    r = token_f1(true.clone(), true, num_labels=NUM)
    assert r["macro_f1"] == 0.0


def _locales(*codes: str) -> torch.Tensor:
    return torch.tensor([LOCALE_TO_ID[code] for code in codes])


def test_per_locale_separates_a_locale_the_global_score_hides():
    # US parses its street perfectly, GB misses its entirely. The concatenated score sits between
    # the two and names neither.
    true = torch.cat([_ids("B-street", "I-street"), _ids("B-street", "I-street")])
    pred = torch.cat([_ids("B-street", "I-street"), _ids("O", "O")])

    overall = token_f1(pred, true, num_labels=NUM)
    per_locale = per_locale_tag_f1(pred, true, _locales("US", "GB"), num_labels=NUM)

    assert 0.0 < overall["f1_tag.street"] < 1.0
    assert per_locale["f1_tag.street.US"] == 1.0
    assert per_locale["f1_tag.street.GB"] == 0.0
    assert per_locale["support_tag.street.GB"] == 2.0


def test_reports_each_locale_row_count_as_the_denominator():
    true = torch.cat([_ids("B-street"), _ids("B-street"), _ids("B-street")])
    per_locale = per_locale_tag_f1(true.clone(), true, _locales("US", "US", "GB"), num_labels=NUM)

    assert per_locale["rows.US"] == 2.0
    assert per_locale["rows.GB"] == 1.0


def test_reports_no_f1_for_a_tag_the_locale_sample_never_carries():
    # DE's rows hold a locality and no street. A 0.0 F1 here would read as a measured street failure.
    true = torch.cat([_ids("B-street", "I-street"), _ids("B-locality", "I-locality")])
    per_locale = per_locale_tag_f1(true.clone(), true, _locales("US", "DE"), num_labels=NUM)

    assert per_locale["f1_tag.street.US"] == 1.0
    assert "f1_tag.street.DE" not in per_locale
    assert per_locale["support_tag.street.DE"] == 0.0
    assert per_locale["rows.DE"] == 1.0


def test_a_predicted_tag_the_sample_never_attests_stays_visible():
    # DE's row holds a locality and the model predicts street over it. Omitting the pair on zero
    # support would hide that prediction from every reported diagnostic.
    true = torch.cat([_ids("B-street", "I-street"), _ids("B-locality", "I-locality")])
    pred = torch.cat([_ids("B-street", "I-street"), _ids("B-street", "I-street")])
    per_locale = per_locale_tag_f1(pred, true, _locales("US", "DE"), num_labels=NUM)

    assert per_locale["support_tag.street.DE"] == 0.0
    assert per_locale["pred_tag.street.DE"] == 2.0
    assert per_locale["fp_tag.street.DE"] == 2.0
    assert "f1_tag.street.DE" not in per_locale


def test_pred_and_fp_separate_a_correct_prediction_from_a_phantom_one():
    true = torch.cat([_ids("B-street", "I-street")])
    per_locale = per_locale_tag_f1(true.clone(), true, _locales("US"), num_labels=NUM)

    assert per_locale["support_tag.street.US"] == 2.0
    assert per_locale["pred_tag.street.US"] == 2.0
    assert per_locale["fp_tag.street.US"] == 0.0


def test_answers_an_empty_mapping_without_locale_ids():
    true = _ids("B-street")

    assert per_locale_tag_f1(true.clone(), true, None, num_labels=NUM) == {}


def test_skips_an_unmapped_locale_id():
    true = torch.cat([_ids("B-street"), _ids("B-street")])
    ids = torch.tensor([LOCALE_TO_ID["US"], IGNORE_INDEX])
    per_locale = per_locale_tag_f1(true.clone(), true, ids, num_labels=NUM)

    assert per_locale["rows.US"] == 1.0
    assert not any(key.endswith(str(IGNORE_INDEX)) for key in per_locale)
