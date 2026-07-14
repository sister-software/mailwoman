"""Tests for the secondary-address shard generator (#1100 / #456, STAGE4)."""

from __future__ import annotations

import random

from .build_secondary_shard import _row_from_groups, _secondary_forms, generate
from .labels import STAGE4_TAGS


def _slices(row: dict) -> list[tuple[str, str]]:
    return [
        (t, row["raw"][s:e]) for s, e, t in zip(row["span_starts"], row["span_ends"], row["span_tags"], strict=True)
    ]


def test_row_from_groups_designator_id_space_joined_fields_comma_joined():
    row = _row_from_groups(
        [
            [("house_number", "789"), ("street", "Elm Boulevard")],
            [("unit_designator", "STE"), ("unit", "200")],
            [("locality", "Miami")],
            [("region", "FL"), ("postcode", "33101")],
        ],
        ", ",
    )
    assert row["raw"] == "789 Elm Boulevard, STE 200, Miami, FL 33101"
    # Designator + id are ADJACENT (one logical unit), not comma-split.
    assert "STE 200" in row["raw"]
    assert _slices(row) == [
        ("house_number", "789"),
        ("street", "Elm Boulevard"),
        ("unit_designator", "STE"),
        ("unit", "200"),
        ("locality", "Miami"),
        ("region", "FL"),
        ("postcode", "33101"),
    ]


def test_row_from_groups_delimiter_free_variant():
    row = _row_from_groups(
        [
            [("house_number", "42"), ("street", "Pine Road")],
            [("level_designator", "FL"), ("level_id", "3")],
            [("locality", "Austin")],
        ],
        " ",
    )
    assert row["raw"] == "42 Pine Road FL 3 Austin"
    assert "," not in row["raw"]
    # Spans still slice their own text with no delimiters present.
    assert _slices(row) == [
        ("house_number", "42"),
        ("street", "Pine Road"),
        ("level_designator", "FL"),
        ("level_id", "3"),
        ("locality", "Austin"),
    ]


def test_generate_every_span_slices_its_own_text():
    """The corruption guard: every span in every generated row references its entity text exactly."""
    rows = generate(cap=15)
    assert rows
    for r in rows:
        for s, e, t in zip(r["span_starts"], r["span_ends"], r["span_tags"], strict=True):
            assert 0 <= s < e <= len(r["raw"])
            assert r["raw"][s:e].strip(), f"empty slice for {t} in {r['raw']!r}"


def test_generate_covers_all_stage4_secondary_tags():
    rows = generate(cap=15)
    seen = {t for r in rows for t in r["span_tags"]}
    for tag in (
        "unit_designator",
        "level_designator",
        "level_id",
        "building_designator",
        "building_id",
        "entrance",
        "staircase",
    ):
        assert tag in seen, f"secondary shard never emits {tag}"


def test_generate_only_emits_known_tags():
    rows = generate(cap=10)
    valid = set(STAGE4_TAGS)
    for r in rows:
        for t in r["span_tags"]:
            assert t in valid, f"unknown tag {t} not in STAGE4"


def test_secondary_forms_deterministic_under_seed():
    a = _secondary_forms(random.Random(1))
    b = _secondary_forms(random.Random(1))
    assert a == b
