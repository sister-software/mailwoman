"""Full-epoch mixture audit (HANDOFF-CODEX-TO-CLAUDE §6 action 7).

The 250k-row prefix audits ended before any source exhausted, so they could not see the
non-stationary sampler. ``audit_epoch_mixture.audit_mixture`` consumes a full row-limited
epoch and reports requested vs realized source/country mix at two levels: raw DRAWS (the
sampler's stationarity receipt) and EMITTED rows under the train augmentation policy (the
unit the model reads — augmentable sources claim extra share of a row_limit).
"""

from __future__ import annotations

import random
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from mailwoman_train.audit_epoch_mixture import (
    CorpusReceiptError,
    audit_mixture,
    corpus_receipt_binding,
    run,
    verify_corpus_receipt_binding,
    verify_corpus_receipt_report,
)
from mailwoman_train.config import CorpusReceiptConfig

LEGACY_SCHEMA = pa.schema(
    [
        ("raw", pa.string()),
        ("tokens", pa.list_(pa.string())),
        ("labels", pa.list_(pa.string())),
        ("country", pa.string()),
        ("source", pa.string()),
    ]
)


def _rows(source: str, n: int) -> list[dict]:
    return [
        {
            "raw": f"{i} Main Rd {source}",
            "tokens": [str(i), "Main", "Rd", source],
            "labels": ["O", "O", "O", "O"],
            "country": "US",
            "source": source,
        }
        for i in range(n)
    ]


def _tail_rows(source: str, country: str, n: int) -> list[dict]:
    return [
        {
            "raw": f"Barcelona {6000 + i}, Anzoategui, Venezuela",
            "tokens": ["Barcelona", str(6000 + i), "Anzoategui", "Venezuela"],
            "labels": ["B-locality", "B-postcode", "B-region", "B-country"],
            "country": country,
            "source": source,
        }
        for i in range(n)
    ]


def _write_corpus(tmp_path: Path) -> Path:
    corpus = tmp_path / "corpus"
    (corpus / "train").mkdir(parents=True)
    for name, rows in (("part-big.parquet", _rows("big", 300)), ("part-small.parquet", _rows("small", 30))):
        pq.write_table(pa.Table.from_pylist(rows, schema=LEGACY_SCHEMA), corpus / "train" / name)
    return corpus


def _audit(corpus: Path, **overrides) -> dict:
    kwargs = {
        "seed": 43,
        "draws": 400,
        "window": 100,
        "country_weights": {"US": 1.0},
        "source_weights": {"big": 1.0, "small": 1.0},
        "coarse_filter": False,
    }
    kwargs.update(overrides)
    return audit_mixture(corpus, **kwargs)


def test_draw_level_windows_show_a_stationary_mixture(tmp_path: Path) -> None:
    report = _audit(_write_corpus(tmp_path))

    windows = report["draw_level"]["windows"]
    assert len(windows) == 4
    for w in windows:
        assert sum(w.values()) == 100
        assert set(w) == {"big", "small"}, f"a source left the mixture mid-epoch: {dict(w)}"

    totals = report["draw_level"]["totals"]
    assert sum(totals.values()) == 400
    assert report["requested"]["small"] == 0.5
    small_share = totals["small"] / 400
    assert 0.35 < small_share < 0.65

    per_source = report["draw_level"]["per_source"]
    assert set(per_source) == {"big", "small"}
    for src in ("big", "small"):
        assert 0.0 <= per_source[src]["max_window_relative_deviation"] < 0.5


def test_emitted_level_equals_draw_level_when_augmentation_is_off(tmp_path: Path) -> None:
    """With every augmentation at 0 and no relabel lexicon, both passes consume the rng
    identically, so the emitted counts are byte-equal to the draw counts."""
    report = _audit(_write_corpus(tmp_path))

    assert report["emitted_level"]["totals"] == report["draw_level"]["totals"]
    for src, stats in report["emitted_level"]["per_source"].items():
        assert stats["distortion_vs_draw_share"] == 1.0, (src, stats)


def test_emitted_level_counts_augmented_copies_against_the_row_budget(tmp_path: Path) -> None:
    """Augmented copies (original + upper-cased twin at prob 1.0) fill the same row_limit
    budget, so emitted totals still sum to ``draws`` and upper-cased twins are present —
    the distortion the quota design must account for."""
    report = _audit(_write_corpus(tmp_path), augment={"upper_case": 1.0})

    totals = report["emitted_level"]["totals"]
    assert sum(totals.values()) == 400
    assert report["emitted_level"]["augmented_share"] > 0.3


def _seeded_control_shares(corpus: Path) -> tuple[float, float]:
    """Two independent seeds' small-source shares, for the determinism check below."""
    a = audit_mixture(
        corpus,
        seed=1,
        draws=200,
        window=100,
        country_weights={"US": 1.0},
        source_weights={"big": 1.0, "small": 1.0},
        coarse_filter=False,
    )
    b = audit_mixture(
        corpus,
        seed=1,
        draws=200,
        window=100,
        country_weights={"US": 1.0},
        source_weights={"big": 1.0, "small": 1.0},
        coarse_filter=False,
    )
    return (
        a["draw_level"]["totals"]["small"] / 200,
        b["draw_level"]["totals"]["small"] / 200,
    )


def test_audit_is_deterministic_for_a_fixed_seed(tmp_path: Path) -> None:
    corpus = _write_corpus(tmp_path)
    share_a, share_b = _seeded_control_shares(corpus)
    assert share_a == share_b
    assert random.Random(1).random() == random.Random(1).random()  # sanity on the invariant used


def test_required_receipt_matches_source_country_and_ordered_tail(tmp_path: Path) -> None:
    corpus = tmp_path / "corpus"
    (corpus / "train").mkdir(parents=True)
    pq.write_table(
        pa.Table.from_pylist(_tail_rows("structured", "VE", 20), schema=LEGACY_SCHEMA),
        corpus / "train" / "structured.parquet",
    )
    receipt = CorpusReceiptConfig(
        name="ve-after-locality",
        min_draws=10,
        source="structured",
        country="VE",
        component_sequence=["locality", "postcode", "region"],
    )

    report = _audit(
        corpus,
        draws=20,
        window=10,
        country_weights={"VE": 1.0},
        source_weights={"structured": 1.0},
        required_receipts=[receipt],
    )

    assert report["required_corpus_receipts"][0]["observed_draws"] == 20


def test_required_receipt_fails_for_absent_source(tmp_path: Path) -> None:
    receipt = CorpusReceiptConfig(name="missing", source="structured")
    with pytest.raises(ValueError, match="missing: observed 0 of required 1 draws"):
        _audit(_write_corpus(tmp_path), required_receipts=[receipt])


def test_required_receipt_fails_for_wrong_country(tmp_path: Path) -> None:
    receipt = CorpusReceiptConfig(name="wrong-country", country="VE")
    with pytest.raises(ValueError, match="wrong-country: observed 0 of required 1 draws"):
        _audit(_write_corpus(tmp_path), required_receipts=[receipt])


def test_required_receipt_fails_for_wrong_component_order(tmp_path: Path) -> None:
    receipt = CorpusReceiptConfig(
        name="wrong-order",
        component_sequence=["locality", "postcode", "region"],
    )
    with pytest.raises(ValueError, match="wrong-order: observed 0 of required 1 draws"):
        _audit(_write_corpus(tmp_path), required_receipts=[receipt])


@pytest.mark.parametrize("bad_label", ["X-postcode", "S-postcode", "postcode", "I-postcode"])
def test_required_receipt_rejects_malformed_bio_labels(tmp_path: Path, bad_label: str) -> None:
    corpus = tmp_path / "corpus"
    (corpus / "train").mkdir(parents=True)
    rows = _tail_rows("structured", "VE", 1)
    rows[0]["labels"][1] = bad_label
    pq.write_table(pa.Table.from_pylist(rows, schema=LEGACY_SCHEMA), corpus / "train" / "structured.parquet")
    receipt = CorpusReceiptConfig(
        name="ve-after-locality",
        source="structured",
        country="VE",
        component_sequence=["locality", "postcode", "region"],
    )

    with pytest.raises(ValueError, match="BIO label"):
        _audit(
            corpus,
            draws=1,
            window=1,
            country_weights={"VE": 1.0},
            source_weights={"structured": 1.0},
            required_receipts=[receipt],
        )


def test_receipt_binding_rejects_missing_and_stale_tokens(tmp_path: Path) -> None:
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    (corpus / "MANIFEST.json").write_text('{"version":"one"}\n', encoding="utf-8")
    config = tmp_path / "config.yaml"
    config.write_text("data: {}\n", encoding="utf-8")
    receipts = [CorpusReceiptConfig(name="required")]
    token = corpus_receipt_binding(config, corpus)

    verify_corpus_receipt_binding(config, corpus, receipts, token)
    with pytest.raises(RuntimeError, match="not audited"):
        verify_corpus_receipt_binding(config, corpus, receipts, "")

    config.write_text("data: {max_length: 64}\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="not audited"):
        verify_corpus_receipt_binding(config, corpus, receipts, token)

    config.write_text("data: {}\n", encoding="utf-8")
    token = corpus_receipt_binding(config, corpus)
    (corpus / "MANIFEST.json").write_text('{"version":"two"}\n', encoding="utf-8")
    with pytest.raises(RuntimeError, match="not audited"):
        verify_corpus_receipt_binding(config, corpus, receipts, token)


def test_legacy_config_does_not_require_receipt_binding(tmp_path: Path) -> None:
    verify_corpus_receipt_binding(tmp_path / "missing.yaml", tmp_path / "missing-corpus", [], "")


def test_gpu_receipt_verifier_requires_a_persisted_pass(tmp_path: Path) -> None:
    import json

    corpus = tmp_path / "corpus"
    corpus.mkdir()
    (corpus / "MANIFEST.json").write_text('{"version":"one"}\n', encoding="utf-8")
    config = tmp_path / "config.yaml"
    config.write_text("data: {}\n", encoding="utf-8")
    receipts = [CorpusReceiptConfig(name="required")]
    token = corpus_receipt_binding(config, corpus)
    report_path = tmp_path / "receipt.json"

    with pytest.raises(RuntimeError, match="unreadable"):
        verify_corpus_receipt_report(config, corpus, receipts, token, report_path)

    report_path.write_text(
        json.dumps({"meta": {"corpus_receipt_status": "fail", "corpus_receipt_binding": token}}),
        encoding="utf-8",
    )
    with pytest.raises(RuntimeError, match="not a passing audit"):
        verify_corpus_receipt_report(config, corpus, receipts, token, report_path)

    report_path.write_text(
        json.dumps({"meta": {"corpus_receipt_status": "pass", "corpus_receipt_binding": token}}),
        encoding="utf-8",
    )
    verify_corpus_receipt_report(config, corpus, receipts, token, report_path)


def test_failed_run_persists_observed_receipt_counts(tmp_path: Path) -> None:
    import json

    corpus = _write_corpus(tmp_path)
    (corpus / "MANIFEST.json").write_text('{"version":"test"}\n', encoding="utf-8")
    config = tmp_path / "config.yaml"
    config.write_text(
        f"""data:
  corpus_dir: {corpus}
  country_weights: {{US: 1.0}}
  source_weights: {{big: 1.0, small: 1.0}}
  train_rows_per_epoch: 20
  coarse_filter: false
  required_corpus_receipts:
    - name: missing
      source: structured
train:
  seed: 42
""",
        encoding="utf-8",
    )
    report_path = tmp_path / "receipt.json"

    with pytest.raises(CorpusReceiptError, match="observed 0 of required 1 draws"):
        run(config, json_path=report_path, window=10)

    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["meta"]["corpus_receipt_status"] == "fail"
    assert report["required_corpus_receipts"][0]["observed_draws"] == 0
