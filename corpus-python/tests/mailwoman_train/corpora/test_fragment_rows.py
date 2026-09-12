"""Every fragment renderer agrees with its own text, and keeps agreeing across a split.

Each of these builds `raw` and its char offsets separately — `raw` by joining pieces, the offsets
by advancing a cursor over the same pieces — so the two can disagree and nothing downstream
notices: `char_label_array_from_spans` reads the offsets and paints whatever they point at, and a
row that labels the wrong characters still trains, still exports, and still scores.

So the assertion is the agreement itself: for every span the renderer emits, `raw[start:end]` must
be the surface that span claims to cover. That holds for any input, which is what makes it a check
rather than a copy of the implementation. The token and label lists are checked the same way —
one label per token, `B-` first and `I-` after within a field.
"""

from __future__ import annotations

from typing import Any

import pytest

from mailwoman_train.corpora.fragment import (
    render,
    render_admin_pair,
    render_context,
    render_country_context,
    render_country_leading,
    render_locality_postcode,
    render_unit,
)

#: One call per renderer, with the surfaces each was written for. Multi-word fields throughout,
#: because a single-word field makes a `B-`-only label list and hides an `I-` continuation bug.
CASES: dict[str, dict[str, Any]] = {
    "bare_street": render("Vestre Haugen", None),
    "street_number": render("Vestre Haugen", "74"),
    "bare_locality": render("Eight Mile Plains", None, tag="locality"),
    "locality_postcode": render_locality_postcode("Eight Mile Plains", "4113"),
    "context_trailing": render_context("Rue Henri Barbusse", "12", "Saint Denis", "FI", True, False),
    "context_leading_with_country": render_context("Main Street", "12", "New Plymouth", "NZ", False, True),
    "unit": render_unit("UNIT 711", "139", "BOUVERIE STREET"),
    "admin_pair": render_admin_pair("Eight Mile Plains", "New South Wales"),
    "country_context_comma": render_country_context(
        "Rue Henri Barbusse", "12", "Saint Denis", "United States of America", True, True
    ),
    "country_context_bare": render_country_context(
        "Main Street", "12", "New Plymouth", "United States of America", False, False
    ),
    "country_leading": render_country_leading("United States of America", "Wyoming", "Лорейн"),
}


@pytest.mark.parametrize("name", sorted(CASES))
def test_every_span_covers_the_text_it_claims(name: str) -> None:
    """`raw[start:end]` is the surface, not a neighbour and not an off-by-one slice of it."""
    row = CASES[name]
    raw = row["raw"]
    triple = zip(row["span_starts"], row["span_ends"], row["span_tags"], strict=True)

    for start, end, tag in triple:
        assert 0 <= start < end <= len(raw), f"{name}: {tag} span ({start}, {end}) is outside {raw!r}"
        covered = raw[start:end]
        assert covered == covered.strip(), f"{name}: {tag} span covers {covered!r}, which has an edge space"


@pytest.mark.parametrize("name", sorted(CASES))
def test_the_spans_reconstruct_the_row_in_order(name: str) -> None:
    """Concatenating the covered surfaces in span order returns every token, in the same order.

    A cursor that advances by the wrong separator width still produces spans inside `raw`, so the
    bounds check above passes while each span sits one or two characters off. Reconstructing
    catches that: the covered text stops matching the tokens it is supposed to hold.
    """
    row = CASES[name]
    raw = row["raw"]
    covered = [raw[start:end] for start, end in zip(row["span_starts"], row["span_ends"], strict=True)]
    assert " ".join(covered).split() == row["tokens"], f"{name}: spans cover {covered!r}, tokens are {row['tokens']}"


@pytest.mark.parametrize("name", sorted(CASES))
def test_one_label_per_token(name: str) -> None:
    row = CASES[name]
    assert len(row["labels"]) == len(row["tokens"]), (
        f"{name}: {len(row['labels'])} labels for {len(row['tokens'])} tokens"
    )
    assert row["tokens"] == row["raw"].replace(",", " ").split(), f"{name}: tokens do not re-split from raw"


@pytest.mark.parametrize("name", sorted(CASES))
def test_each_field_opens_with_b_and_continues_with_i(name: str) -> None:
    """An `I-` with no `B-` before it is a field that starts mid-span, which decodes as a fragment."""
    row = CASES[name]
    previous: str | None = None

    for label in row["labels"]:
        assert label != "O", f"{name}: a synthesized row has no unlabeled token"
        prefix, tag = label.split("-", 1)
        if prefix == "I":
            assert previous == tag, f"{name}: I-{tag} follows {previous}, so the field never opened"
        previous = tag


@pytest.mark.parametrize("name", sorted(CASES))
def test_every_span_tag_has_a_matching_label_run(name: str) -> None:
    """The span triple and the BIO labels are two descriptions of one row; they must name the same
    fields in the same order, or the char path and the token path train different things."""
    row = CASES[name]
    from_labels = [label.split("-", 1)[1] for label in row["labels"] if label.startswith("B-")]
    assert from_labels == list(row["span_tags"]), f"{name}: labels say {from_labels}, spans say {row['span_tags']}"
