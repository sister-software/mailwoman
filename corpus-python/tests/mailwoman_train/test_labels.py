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
    coarse_components_present,
    collapse_label,
)


def test_stage1_bio_labels_well_formed():
    assert STAGE1_BIO_LABELS[0] == "O"

    assert len(STAGE1_BIO_LABELS) == 1 + 2 * len(STAGE1_COARSE_TAGS)
    for tag in STAGE1_COARSE_TAGS:
        assert f"B-{tag}" in STAGE1_BIO_LABELS
        assert f"I-{tag}" in STAGE1_BIO_LABELS


def test_stage1_constants_are_immutable_across_ships():

    assert STAGE1_COARSE_TAGS == (
        "country",
        "region",
        "locality",
        "dependent_locality",
        "postcode",
        "subregion",
        "cedex",
    )


def test_stage2_extends_stage1_with_fine_tags():
    assert STAGE2_FINE_TAGS == ("venue", "street", "house_number")
    assert STAGE2_TAGS == STAGE1_COARSE_TAGS + STAGE2_FINE_TAGS

    assert len(STAGE2_BIO_LABELS) == 1 + 2 * len(STAGE2_TAGS)
    for tag in STAGE2_FINE_TAGS:
        assert f"B-{tag}" in STAGE2_BIO_LABELS
        assert f"I-{tag}" in STAGE2_BIO_LABELS


def test_stage2_preserves_stage1_label_ids():

    for i, label in enumerate(STAGE1_BIO_LABELS):
        assert STAGE2_BIO_LABELS[i] == label


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

    assert len(STAGE3_BIO_LABELS) == 1 + 2 * len(STAGE3_TAGS)


def test_stage3_preserves_stage2_label_ids():

    for i, label in enumerate(STAGE2_BIO_LABELS):
        assert STAGE3_BIO_LABELS[i] == label


def test_active_set_points_at_current_stage():

    assert ACTIVE_TAGS == STAGE3_TAGS
    assert ACTIVE_BIO_LABELS == STAGE3_BIO_LABELS


def test_active_set_keeps_historical_stage_prefixes_intact():

    assert ACTIVE_TAGS[: len(STAGE2_TAGS)] == STAGE2_TAGS
    assert ACTIVE_BIO_LABELS[: len(STAGE2_BIO_LABELS)] == STAGE2_BIO_LABELS
    assert ACTIVE_BIO_LABELS[: len(STAGE1_BIO_LABELS)] == STAGE1_BIO_LABELS


def test_collapse_label_keeps_coarse():
    assert collapse_label("B-country") == "B-country"
    assert collapse_label("I-region") == "I-region"
    assert collapse_label("O") == "O"


def test_collapse_label_keeps_fine_v0_3_0():

    assert collapse_label("B-venue") == "B-venue"
    assert collapse_label("I-street") == "I-street"
    assert collapse_label("B-house_number") == "B-house_number"


def test_collapse_label_keeps_stage3_tags():

    assert collapse_label("B-street_prefix") == "B-street_prefix"
    assert collapse_label("I-street_suffix") == "I-street_suffix"
    assert collapse_label("I-po_box") == "I-po_box"
    assert collapse_label("B-intersection_a") == "B-intersection_a"


def test_collapse_label_drops_tags_not_in_active_set():

    assert collapse_label("B-attention") == "O"
    assert collapse_label("B-entrance") == "O"
    assert collapse_label("I-unit_designator") == "O"


def test_collapse_label_drops_unknown_tags():
    assert collapse_label("B-not_a_real_tag") == "O"
    assert collapse_label("malformed") == "O"


def test_active_components_present_accepts_coarse_only_rows():

    assert active_components_present(["country", "region"]) is True
    assert active_components_present(["locality"]) is True
    assert active_components_present(["postcode"]) is True


def test_active_components_present_accepts_fine_only_rows():

    assert active_components_present(["house_number", "street"]) is True
    assert active_components_present(["street"]) is True
    assert active_components_present(["venue"]) is True


def test_active_components_present_rejects_empty_and_irrelevant():
    assert active_components_present([]) is False

    assert active_components_present(["attention", "entrance", "staircase"]) is False


def test_coarse_components_present_alias():

    assert coarse_components_present is active_components_present
