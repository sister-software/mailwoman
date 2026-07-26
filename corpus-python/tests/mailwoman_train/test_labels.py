"""Label-collapsing + active-presence filter tests."""

from mailwoman_train.labels import (
    ACTIVE_BIO_LABELS,
    ACTIVE_TAGS,
    STAGE1_BIO_LABELS,
    STAGE1_COARSE_TAGS,
    STAGE2_BIO_LABELS,
    STAGE2_FINE_TAGS,
    STAGE2_TAGS,
    STAGE3_BIO_LABELS,
    STAGE3_FINE_TAGS,
    STAGE3_TAGS,
    active_components_present,
    coarse_components_present,  # alias for back-compat
    collapse_label,
)

# --- Historical (frozen) -------------------------------------------------------------


def test_stage1_bio_labels_well_formed():
    assert STAGE1_BIO_LABELS[0] == "O"
    # 1 O + 7 coarse tags × 2 (B-/I-) = 15
    assert len(STAGE1_BIO_LABELS) == 1 + 2 * len(STAGE1_COARSE_TAGS)
    for tag in STAGE1_COARSE_TAGS:
        assert f"B-{tag}" in STAGE1_BIO_LABELS
        assert f"I-{tag}" in STAGE1_BIO_LABELS


def test_stage1_constants_are_immutable_across_ships():
    # Reproducibility contract: anyone diffing a v0.1.0 / v0.2.0 checkpoint against
    # today's label space must see the same 15-label tuple in the same order.
    assert STAGE1_COARSE_TAGS == (
        "country",
        "region",
        "locality",
        "dependent_locality",
        "postcode",
        "subregion",
        "cedex",
    )


# --- v0.3.0 STAGE2 -------------------------------------------------------------------


def test_stage2_extends_stage1_with_fine_tags():
    assert STAGE2_FINE_TAGS == ("venue", "street", "house_number")
    assert STAGE2_TAGS == STAGE1_COARSE_TAGS + STAGE2_FINE_TAGS
    # 1 O + 10 tags × 2 = 21 labels
    assert len(STAGE2_BIO_LABELS) == 1 + 2 * len(STAGE2_TAGS)
    for tag in STAGE2_FINE_TAGS:
        assert f"B-{tag}" in STAGE2_BIO_LABELS
        assert f"I-{tag}" in STAGE2_BIO_LABELS


def test_stage2_preserves_stage1_label_ids():
    # STAGE2 appends fine labels AFTER all STAGE1 entries so old label IDs remain valid
    # if anyone reloads an old checkpoint and only consults the first 15 indices.
    for i, label in enumerate(STAGE1_BIO_LABELS):
        assert STAGE2_BIO_LABELS[i] == label


# --- v0.6.0 STAGE3 (current active set) --------------------------------------------


def test_stage3_extends_stage2_with_decomposition_tags():
    assert STAGE3_FINE_TAGS == (
        "street_prefix",
        "street_suffix",
        "unit",
        "po_box",
        "intersection_a",
        "intersection_b",
    )
    assert STAGE3_TAGS == STAGE2_TAGS + STAGE3_FINE_TAGS
    # 1 O + 16 tags × 2 = 33 labels
    assert len(STAGE3_BIO_LABELS) == 1 + 2 * len(STAGE3_TAGS)


def test_stage3_preserves_stage2_label_ids():
    # Same append-only contract as Stage 1 → 2: a v0.3.0–v0.5.x checkpoint's first 21
    # label IDs stay valid under the Stage 3 vocabulary.
    for i, label in enumerate(STAGE2_BIO_LABELS):
        assert STAGE3_BIO_LABELS[i] == label


def test_active_set_points_at_current_stage():
    # ACTIVE_* tracks the CURRENT training round's vocabulary — STAGE3 as of the v0.6.0
    # ship (STAGE4 is defined in labels.py but deliberately NOT active; its activation
    # couples to a retrain + the JS ComponentTag union bump). When the ship-line moves,
    # this sentinel moves with it in the same commit — never pin ACTIVE to a historical
    # stage.
    assert ACTIVE_TAGS == STAGE3_TAGS
    assert ACTIVE_BIO_LABELS == STAGE3_BIO_LABELS


def test_active_set_keeps_historical_stage_prefixes_intact():
    # The staged-tuple discipline: every historical stage is an intact PREFIX of the
    # active lineage, so old checkpoints keep valid label IDs under the new vocabulary.
    assert ACTIVE_TAGS[: len(STAGE2_TAGS)] == STAGE2_TAGS
    assert ACTIVE_BIO_LABELS[: len(STAGE2_BIO_LABELS)] == STAGE2_BIO_LABELS
    assert ACTIVE_BIO_LABELS[: len(STAGE1_BIO_LABELS)] == STAGE1_BIO_LABELS


# --- collapse_label ------------------------------------------------------------------


def test_collapse_label_keeps_coarse():
    assert collapse_label("B-country") == "B-country"
    assert collapse_label("I-region") == "I-region"
    assert collapse_label("O") == "O"


def test_collapse_label_keeps_fine_v0_3_0():
    # Behavior change from v0.2.0: venue/street/house_number now survive collapse.
    assert collapse_label("B-venue") == "B-venue"
    assert collapse_label("I-street") == "I-street"
    assert collapse_label("B-house_number") == "B-house_number"


def test_collapse_label_keeps_stage3_tags():
    # Stage 3 (v0.6.0): street decomposition + unit/po_box/intersection survive collapse.
    assert collapse_label("B-street_prefix") == "B-street_prefix"
    assert collapse_label("I-street_suffix") == "I-street_suffix"
    assert collapse_label("I-po_box") == "I-po_box"
    assert collapse_label("B-intersection_a") == "B-intersection_a"


def test_collapse_label_drops_tags_not_in_active_set():
    # Tags that exist in the JS-side ComponentTag union but aren't in ACTIVE_TAGS yet
    # (e.g. attention) still collapse to O. STAGE4 tags are DEFINED in labels.py but
    # NOT active (activation is coupled to a retrain + the JS union bump) — they
    # collapse too.
    assert collapse_label("B-attention") == "O"
    assert collapse_label("B-entrance") == "O"
    assert collapse_label("I-unit_designator") == "O"


def test_collapse_label_drops_unknown_tags():
    assert collapse_label("B-not_a_real_tag") == "O"
    assert collapse_label("malformed") == "O"


# --- active_components_present (relaxed gate) ---------------------------------------


def test_active_components_present_accepts_coarse_only_rows():
    # WOF-admin shape: country + region, no fine tags. Still passes the gate.
    assert active_components_present(["country", "region"]) is True
    assert active_components_present(["locality"]) is True
    assert active_components_present(["postcode"]) is True


def test_active_components_present_accepts_fine_only_rows():
    # v0.3.0 expansion: BAN/TIGER shape (house_number + street, no coarse tags) now passes.
    # Previously dropped — was the upstream cause of the v0.1.0 positional-heuristic overfit.
    assert active_components_present(["house_number", "street"]) is True
    assert active_components_present(["street"]) is True
    assert active_components_present(["venue"]) is True


def test_active_components_present_rejects_empty_and_irrelevant():
    assert active_components_present([]) is False
    # `attention` is in no stage; `entrance`/`staircase` are STAGE4 — defined but not
    # active — so none of these count toward the gate.
    assert active_components_present(["attention", "entrance", "staircase"]) is False


def test_coarse_components_present_alias():
    # Back-compat alias should behave identically to active_components_present.
    assert coarse_components_present is active_components_present
