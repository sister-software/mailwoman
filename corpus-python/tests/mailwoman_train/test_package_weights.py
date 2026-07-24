"""ModelCard + README rendering tests, pinned to the active label stage.

Frozen-string tests would couple the prose to every minor wording change, so the
asserts target the essential facts: phase string, component list, target
status, smoke-disclaimer presence. The phase assertions track the CURRENT stage
(STAGE3 as of the v0.6.0 ship) and move with ``labels.ACTIVE_TAGS`` at each
stage bump — never pin them to a historical stage (#1247).
"""

from __future__ import annotations

from pathlib import Path

from mailwoman_train.labels import ACTIVE_BIO_LABELS, ACTIVE_TAGS, STAGE2_FINE_TAGS
from mailwoman_train.package_weights import (
    _components_supported_blurb,
    _phase_label,
    _target_status_line,
    build_model_card,
    render_readme,
)


def test_phase_label_reports_current_stage():
    # With ACTIVE_TAGS pointing at STAGE3_TAGS (the v0.6.0 ship-line), the phase
    # label must mention Stage 3 — otherwise the published model card silently
    # mislabels itself. The named-stage branch must fire, not the "Custom" fallback.
    label = _phase_label()
    assert "Stage 3" in label, f"unexpected phase label {label!r}"
    assert not label.startswith("Custom"), f"phase label fell through to the fallback: {label!r}"


def test_model_card_lists_all_active_components():
    card = build_model_card(
        locale="en-us",
        corpus_version="0.3.0",
        tokenizer_version="0.1.0",
        training_steps=50000,
        eval_report={"per_component": {}, "n_entries": 0},
        notes="",
        training_hardware="cpu-test",
        training_duration_seconds=0,
        base_path=Path("/tmp/ck"),
        package_version="0.3.0",
    )
    assert card["phase"] == _phase_label()
    assert card["components_supported"] == list(ACTIVE_TAGS)
    # The three Stage 2 fine labels must surface.
    for tag in STAGE2_FINE_TAGS:
        assert tag in card["components_supported"], f"missing {tag!r}"


def test_model_card_carries_bio_labels_in_emission_order():
    # v0.4.0 issue #116 §5(a): the trained label vocabulary travels with the bundle so
    # the JS-side classifier can read it at runtime instead of hardcoding STAGE2_BIO_LABELS.
    # Order is critical — emission logits map positionally onto this array.
    card = build_model_card(
        locale="en-us",
        corpus_version="0.3.0",
        tokenizer_version="0.1.0",
        training_steps=50000,
        eval_report={"per_component": {}, "n_entries": 0},
        notes="",
        training_hardware="cpu-test",
        training_duration_seconds=0,
        base_path=Path("/tmp/ck"),
        package_version="0.3.0",
    )
    assert "labels" in card, "model card must carry the BIO label vocabulary"
    assert card["labels"] == list(ACTIVE_BIO_LABELS)
    # First label is `O` by construction across every stage.
    assert card["labels"][0] == "O"


def test_components_blurb_mentions_fine_tags():
    blurb = _components_supported_blurb()
    for tag in STAGE2_FINE_TAGS:
        assert tag in blurb, f"blurb missing {tag!r}: {blurb!r}"


def test_target_status_uses_stage2_floors_for_fine_labels():
    # venue/street/house_number get the v0.3.0 issue-spec floors (0.60/0.70/0.80),
    # not the 0.95 coarse contract. Provide eval numbers right between the two
    # bands so the assertion only passes if the correct floor is in effect.
    report = {
        "per_component": {
            "country": {"f1": 0.99},
            "venue": {"f1": 0.65},  # above 0.60 floor → "at target"
            "street": {"f1": 0.55},  # below 0.70 floor → "below"
            "house_number": {"f1": 0.95},  # above 0.80 floor → "at target"
        }
    }
    line = _target_status_line(report)
    assert "street" in line and "0.5500" in line
    assert "target ≥0.70" in line
    # venue lands "at target" — its 0.65 is above the 0.60 floor, so it should
    # NOT show in the "below" list. The string `0.6500` should not appear.
    assert "0.6500" not in line


def test_readme_includes_phase_and_components():
    md = render_readme(
        locale="en-us",
        corpus_version="0.3.0",
        eval_report={"per_component": {}, "n_entries": 0, "full_parse_exact_match": 0.0, "mean_token_confidence": 0.0},
        training_steps=50000,
        training_hardware="gfx1103",
        smoke=False,
    )
    assert _phase_label() in md
    assert "venue" in md
    assert "street" in md
    assert "house_number" in md
    # SMOKE BUILD warning must NOT appear when smoke=False.
    assert "SMOKE BUILD" not in md


def test_readme_smoke_warning_present_when_smoke():
    md = render_readme(
        locale="en-us",
        corpus_version="0.3.0",
        eval_report={"per_component": {}, "n_entries": 0, "full_parse_exact_match": 0.0, "mean_token_confidence": 0.0},
        training_steps=10,
        training_hardware="cpu-test",
        smoke=True,
    )
    assert "SMOKE BUILD" in md
