"""Label-collapsing + coarse-presence filter tests."""

from mailwoman_train.labels import (
    STAGE1_BIO_LABELS,
    STAGE1_COARSE_TAGS,
    coarse_components_present,
    collapse_label,
)


def test_stage1_bio_labels_well_formed():
    assert STAGE1_BIO_LABELS[0] == "O"
    # 1 O + 7 coarse tags × 2 (B-/I-) = 15
    assert len(STAGE1_BIO_LABELS) == 1 + 2 * len(STAGE1_COARSE_TAGS)
    for tag in STAGE1_COARSE_TAGS:
        assert f"B-{tag}" in STAGE1_BIO_LABELS
        assert f"I-{tag}" in STAGE1_BIO_LABELS


def test_collapse_label_keeps_coarse():
    assert collapse_label("B-country") == "B-country"
    assert collapse_label("I-region") == "I-region"
    assert collapse_label("O") == "O"


def test_collapse_label_drops_street_and_venue():
    assert collapse_label("B-house_number") == "O"
    assert collapse_label("I-street") == "O"
    assert collapse_label("B-venue") == "O"
    assert collapse_label("B-attention") == "O"


def test_collapse_label_drops_unknown_tags():
    assert collapse_label("B-not_a_real_tag") == "O"
    assert collapse_label("malformed") == "O"


def test_coarse_components_present_requires_country_plus_one():
    assert coarse_components_present(["country", "region"]) is True
    assert coarse_components_present(["country", "locality"]) is True
    assert coarse_components_present(["country", "postcode"]) is True
    assert coarse_components_present(["country", "subregion"]) is False  # subregion is not one of the three
    assert coarse_components_present(["country"]) is False
    assert coarse_components_present(["region", "locality"]) is False  # no country
    assert coarse_components_present([]) is False
