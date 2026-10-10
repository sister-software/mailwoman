"""Test the per-label validation floor: which labels a row holds, and which declared floors a count misses."""

from mailwoman_train.audits.label_support import failing_label_floors, head_labels
from mailwoman_train.config import LabelSupportConfig
from mailwoman_train.data.loader import IGNORE_INDEX

BIO = ["O", "B-locality", "I-locality", "B-po_box", "I-po_box", "B-unit"]


def test_a_row_holds_the_labels_whose_b_tag_any_piece_carries() -> None:
    assert head_labels([0, 1, 2, 3, 4, IGNORE_INDEX], BIO) == {"locality", "po_box"}


def test_an_i_tag_without_its_b_tag_does_not_count_as_holding_the_label() -> None:
    assert head_labels([0, 2, IGNORE_INDEX], BIO) == set()


def test_a_met_floor_reports_no_failure() -> None:
    counts = {"val": {"po_box": 120, "unit": 900}}
    required = [LabelSupportConfig(label="po_box", min_rows=100), LabelSupportConfig(label="unit", min_rows=500)]

    assert failing_label_floors(counts, required) == []


def test_a_label_the_split_holds_no_row_for_fails_at_zero() -> None:
    counts = {"val": {"locality": 4_000}}
    required = [LabelSupportConfig(label="po_box", min_rows=100)]

    failures = failing_label_floors(counts, required)

    assert len(failures) == 1
    assert failures[0]["rows"] == 0
    assert "0 rows hold po_box against a floor of 100" in failures[0]["because"]


def test_a_label_below_its_floor_reports_the_count_it_reached() -> None:
    counts = {"val": {"po_box": 3}}
    required = [LabelSupportConfig(label="po_box", min_rows=100)]

    failures = failing_label_floors(counts, required)

    assert failures[0]["rows"] == 3
    assert "3 rows hold po_box against a floor of 100" in failures[0]["because"]


def test_a_split_that_was_not_counted_is_unmeasured_rather_than_zero() -> None:
    counts = {"val": {"po_box": 300}}
    required = [LabelSupportConfig(label="po_box", split="test", min_rows=100)]

    failures = failing_label_floors(counts, required)

    assert failures[0]["rows"] is None
    assert "was not counted" in failures[0]["because"]
