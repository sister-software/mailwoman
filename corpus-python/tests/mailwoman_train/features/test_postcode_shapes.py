"""The vendored postcode-shape record and the finder the training encoder compiles from it.

The record has two copies, the authored one in `@mailwoman/postcode` and the one beside the training package, which
must stay byte-identical because a Modal container receives only `corpus-python/src`. The training encoder compiles
the vendored copy in Rust with Python's `re` semantics (`mailwoman_mtf.PostcodeShapes`), skipping each row the record
marks `javascriptOnly`.
"""

from __future__ import annotations

import json
import re

import mailwoman_mtf
import pytest

from mailwoman_train.data.loader.encode import POSTCODE_SHAPES
from tests import paths

AUTHORED_RECORD = paths.REPO_ROOT / "packages" / "postcode" / "lib" / "shapes.json"
RECORD = json.loads(POSTCODE_SHAPES.read_text(encoding="utf-8"))
EXEMPT = {shape["label"]: shape["javascriptOnly"] for shape in RECORD["shapes"] if "javascriptOnly" in shape}


@pytest.fixture(scope="module")
def shapes() -> mailwoman_mtf.PostcodeShapes:
    return mailwoman_mtf.PostcodeShapes(str(POSTCODE_SHAPES))


def test_the_vendored_record_is_byte_identical_to_the_authored_one() -> None:
    """A byte compare cannot be defeated by a formatting change that a source-text parser silently stops matching."""
    assert AUTHORED_RECORD.is_file(), (
        f"the authored record is not at {AUTHORED_RECORD}; this test reads a path no compiler checks, "
        "so a workspace move breaks it silently"
    )
    assert POSTCODE_SHAPES.read_bytes() == AUTHORED_RECORD.read_bytes(), (
        f"{POSTCODE_SHAPES} has drifted from {AUTHORED_RECORD}. The @mailwoman/postcode copy is the authored one — "
        "copy it here rather than editing this side."
    )


def test_each_exempt_row_is_one_pythons_re_refuses() -> None:
    """The one exemption is the 〒-marked Japanese row, whose variable-width lookbehind Python's `re` refuses."""
    assert set(EXEMPT) == {"JP-marked"}, f"the exempt set changed: {sorted(EXEMPT)}"
    for shape in RECORD["shapes"]:
        if shape["label"] in EXEMPT:
            with pytest.raises(re.error):
                re.compile(shape["pattern"])
            assert EXEMPT[shape["label"]].strip(), f"{shape['label']} is exempt with no reason given"


def test_the_finder_compiles_every_other_row_in_record_order(shapes: mailwoman_mtf.PostcodeShapes) -> None:
    """Priority is the index, so dropping a row must not reorder the rest. NUM5, the catch-all, stays last."""
    readable = [shape["label"] for shape in RECORD["shapes"] if shape["label"] not in EXEMPT]
    assert shapes.labels == readable
    assert len(readable) == len(RECORD["shapes"]) - len(EXEMPT) >= 12
    assert shapes.labels[-1] == "NUM5"


def spans(shapes: mailwoman_mtf.PostcodeShapes, text: str) -> list[str]:
    return [text[start:end] for start, end, _kind, _priority in shapes.collect_matches(text)]


def test_ie_eircode_is_detected_as_one_span(shapes: mailwoman_mtf.PostcodeShapes) -> None:
    assert spans(shapes, "Ballinlough, T12 X70A, Cork") == ["T12 X70A"]


def test_br_cep_claims_the_sector_suffix(shapes: mailwoman_mtf.PostcodeShapes) -> None:
    assert spans(shapes, "Rua Ramiro Barcelos, Porto Alegre 95090-020") == ["95090-020"]


def test_zip4_claims_the_span_the_nl_shape_would_take(shapes: mailwoman_mtf.PostcodeShapes) -> None:
    found = spans(shapes, "1234 Broadway, Oakland 94610-2737 CA")
    assert "94610-2737" in found and "2737 CA" not in found


def test_a_five_digit_run_and_a_house_number_shape_match(shapes: mailwoman_mtf.PostcodeShapes) -> None:
    assert [(s, e) for s, e, _, _ in shapes.collect_matches("Strasse 12 10115 Berlin")] == [(11, 16)]
    assert [(s, e) for s, e, _, _ in shapes.collect_matches("12345 Main St")] == [(0, 5)]
