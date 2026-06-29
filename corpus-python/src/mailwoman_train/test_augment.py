"""Tests for training-time augmentation."""

import random

import pytest

from .augment import (
    _expand_token,
    augment_row,
    glue_region_postcode,
    lowercase_row,
    row_span_triple,
    splice_expansion,
)
from .tokenizer import PieceSpan, realign_labels_to_pieces, realign_spans_to_pieces


def test_expand_token_single_word():
    tokens = ["350", "5th", "Ave", "NW"]
    labels = ["B-house_number", "B-street", "I-street", "I-street"]
    new_tokens, new_labels = _expand_token(tokens, labels, 3, "Northwest")
    assert new_tokens == ["350", "5th", "Ave", "Northwest"]
    assert new_labels == ["B-house_number", "B-street", "I-street", "I-street"]


def test_expand_token_multi_word_b_label():
    tokens = ["Washington", ",", "DC"]
    labels = ["B-region", "O", "B-region"]
    # Expand "DC" → "District of Columbia"
    new_tokens, new_labels = _expand_token(tokens, labels, 2, "District of Columbia")
    assert new_tokens == ["Washington", ",", "District", "of", "Columbia"]
    assert new_labels == ["B-region", "O", "B-region", "I-region", "I-region"]


def test_expand_token_multi_word_i_label():
    tokens = ["New", "York", ",", "NY"]
    labels = ["B-locality", "I-locality", "O", "B-region"]
    # Expand "NY" → "New York" (B-region stays B-region, second word gets I-region)
    new_tokens, new_labels = _expand_token(tokens, labels, 3, "New York")
    assert new_tokens == ["New", "York", ",", "New", "York"]
    assert new_labels == ["B-locality", "I-locality", "O", "B-region", "I-region"]


def test_augment_row_original_always_yielded():
    row = {
        "raw": "350 5th Ave NW",
        "tokens": ["350", "5th", "Ave", "NW"],
        "labels": ["B-house_number", "B-street", "I-street", "I-street"],
        "country": "US",
        "source": "tiger",
    }
    rng = random.Random(42)
    results = list(augment_row(row, rng, directional_prob=0.0, region_prob=0.0))
    assert len(results) == 1
    assert results[0] is row


def test_augment_row_directional_fires():
    row = {
        "raw": "350 5th Ave NW",
        "tokens": ["350", "5th", "Ave", "NW"],
        "labels": ["B-house_number", "B-street", "I-street", "I-street"],
        "country": "US",
        "source": "tiger",
    }
    rng = random.Random(42)
    results = list(augment_row(row, rng, directional_prob=1.0, region_prob=0.0))
    assert len(results) == 2
    assert results[0] is row
    assert "Northwest" in results[1]["tokens"]


def test_augment_row_region_fires():
    row = {
        "raw": "New York , NY",
        "tokens": ["New", "York", ",", "NY"],
        "labels": ["B-locality", "I-locality", "O", "B-region"],
        "country": "US",
        "source": "tiger",
    }
    rng = random.Random(42)
    results = list(augment_row(row, rng, directional_prob=0.0, region_prob=1.0))
    assert len(results) == 2
    augmented = results[1]
    # "NY" should be expanded to "New" "York" with B-region I-region
    assert "B-region" in augmented["labels"]
    assert "I-region" in augmented["labels"]


def test_augment_row_no_match_no_extra():
    row = {
        "raw": "123 Main St",
        "tokens": ["123", "Main", "St"],
        "labels": ["B-house_number", "B-street", "I-street"],
        "country": "US",
        "source": "tiger",
    }
    rng = random.Random(42)
    # Even with prob=1.0, no directionals or region abbreviations → no augmented copy
    results = list(augment_row(row, rng, directional_prob=1.0, region_prob=1.0))
    assert len(results) == 1


def test_augment_row_region_only_expands_region_labeled():
    row = {
        "raw": "PA Ave , DC",
        "tokens": ["PA", "Ave", ",", "DC"],
        "labels": ["B-street", "I-street", "O", "B-region"],
        "country": "US",
        "source": "tiger",
    }
    rng = random.Random(42)
    results = list(augment_row(row, rng, directional_prob=0.0, region_prob=1.0))
    assert len(results) == 2
    augmented = results[1]
    # PA (labeled B-street) should NOT be expanded — only DC (B-region) should
    assert augmented["tokens"][0] == "PA"
    assert "District" in augmented["tokens"]


# --- Region+postcode glue (#513) ---------------------------------------------------------------


def _glue_row() -> dict:
    return {
        "raw": "123 Main St Buffalo NY 14201",
        "tokens": ["123", "Main", "St", "Buffalo", "NY", "14201"],
        "labels": ["B-house_number", "B-street", "I-street", "B-locality", "B-region", "B-postcode"],
        "country": "US",
        "source": "tiger",
    }


def test_glue_fuses_raw_only():
    row = _glue_row()
    rng = random.Random(42)
    results = list(augment_row(row, rng, directional_prob=0.0, region_prob=0.0, glue_prob=1.0))
    assert len(results) == 2
    assert results[0] is row
    fused = results[1]
    assert fused["raw"] == "123 Main St Buffalo NY14201"
    # Tokens + labels stay split — the whole point of the augmentation.
    assert fused["tokens"] == row["tokens"]
    assert fused["labels"] == row["labels"]


def test_glue_preserves_original_punctuation():
    row = {
        "raw": "Buffalo, NY 14201",
        "tokens": ["Buffalo", ",", "NY", "14201"],
        "labels": ["B-locality", "O", "B-region", "B-postcode"],
        "country": "US",
        "source": "tiger",
    }
    fused = glue_region_postcode(row, 2)
    # Splices the original raw (comma spacing intact), not a re-join of tokens.
    assert fused["raw"] == "Buffalo, NY14201"


def test_glue_fuses_last_token_of_multi_token_region():
    row = {
        "raw": "Springfield New York 10001",
        "tokens": ["Springfield", "New", "York", "10001"],
        "labels": ["B-locality", "B-region", "I-region", "B-postcode"],
        "country": "US",
        "source": "tiger",
    }
    rng = random.Random(42)
    results = list(augment_row(row, rng, directional_prob=0.0, region_prob=0.0, glue_prob=1.0))
    assert len(results) == 2
    assert results[1]["raw"] == "Springfield New York10001"


def test_glue_requires_digit_leading_postcode():
    # GB-style letter-leading postcode: fusing would create a letter→letter boundary
    # SentencePiece may not split — must NOT fire.
    row = {
        "raw": "London England SW1A 1AA",
        "tokens": ["London", "England", "SW1A", "1AA"],
        "labels": ["B-locality", "B-region", "B-postcode", "I-postcode"],
        "country": "GB",
        "source": "wof-admin",
    }
    rng = random.Random(42)
    results = list(augment_row(row, rng, directional_prob=0.0, region_prob=0.0, glue_prob=1.0))
    assert len(results) == 1


def test_glue_requires_adjacency():
    row = {
        "raw": "Buffalo NY USA 14201",
        "tokens": ["Buffalo", "NY", "USA", "14201"],
        "labels": ["B-locality", "B-region", "B-country", "B-postcode"],
        "country": "US",
        "source": "tiger",
    }
    rng = random.Random(42)
    results = list(augment_row(row, rng, directional_prob=0.0, region_prob=0.0, glue_prob=1.0))
    assert len(results) == 1


def test_glue_default_off_preserves_rng_stream():
    # glue_prob=0 must not consume an rng draw — existing recipes stay bit-identical.
    # (directional + region each always draw once; glue must not add a third.)
    ref = random.Random(7)
    ref.random(), ref.random()
    expected = ref.random()
    rng = random.Random(7)
    list(augment_row(_glue_row(), rng, directional_prob=0.0, region_prob=0.0, glue_prob=0.0))
    assert rng.random() == expected


def test_glued_raw_projects_split_labels_onto_pieces():
    """The critical property (#513): the fused surface with SPLIT tokens/labels projects
    B-region onto the letter pieces and B/I-postcode onto the digit pieces via char offsets.
    Mock pieces mirror the v0.6.0-a0 tokenizer's letter/digit split (verified empirically:
    1020 fused state+ZIP rows, zero pieces straddling the letter→digit boundary)."""
    row = {
        "raw": "Buffalo NY 14201",
        "tokens": ["Buffalo", "NY", "14201"],
        "labels": ["B-locality", "B-region", "B-postcode"],
    }
    fused = glue_region_postcode(row, 1)
    assert fused["raw"] == "Buffalo NY14201"

    def _piece(text: str, begin: int, end: int) -> PieceSpan:
        return PieceSpan(piece=text, piece_id=0, char_begin=begin, char_end=end)

    pieces = [
        _piece("Buffalo", 0, 7),
        _piece("NY", 8, 10),
        _piece("142", 10, 13),
        _piece("01", 13, 15),
    ]
    bio = realign_labels_to_pieces(fused["raw"], fused["tokens"], fused["labels"], pieces)
    assert bio == ["B-locality", "B-region", "B-postcode", "I-postcode"]


# --- Char-offset span re-target (#519) ----------------------------------------------------------
# Every augmented COPY must carry spans consistent with ITS raw — the mutation-upstream hazard
# this slice exists to close.


def _slices(row: dict) -> list[tuple[str, str]]:
    """(tag, raw slice) pairs for a row's span triple."""
    return [
        (t, row["raw"][s:e])
        for s, e, t in zip(row["span_starts"], row["span_ends"], row["span_tags"])
    ]


def _spanned_directional_row() -> dict:
    return {
        "raw": "350 5th Ave NW",
        "tokens": ["350", "5th", "Ave", "NW"],
        "labels": ["B-house_number", "B-street", "I-street", "I-street"],
        "span_starts": [0, 4],
        "span_ends": [3, 14],
        "span_tags": ["house_number", "street"],
        "country": "US",
        "source": "tiger",
    }


def _assert_span_invariants(row: dict) -> None:
    """The #519 triple invariants: in-bounds, sorted ascending by start, non-overlapping."""
    prev_end = 0
    for s, e in zip(row["span_starts"], row["span_ends"]):
        assert 0 <= s < e <= len(row["raw"])
        assert s >= prev_end
        prev_end = e


def test_expansion_splices_raw_and_retargets_spans():
    rng = random.Random(42)
    results = list(augment_row(_spanned_directional_row(), rng, directional_prob=1.0, region_prob=0.0))
    assert len(results) == 2
    augmented = results[1]
    assert augmented["raw"] == "350 5th Ave Northwest"
    assert _slices(augmented) == [("house_number", "350"), ("street", "5th Ave Northwest")]
    _assert_span_invariants(augmented)


def test_expansion_leaves_the_original_rows_spans_alone():
    row = _spanned_directional_row()
    rng = random.Random(42)
    results = list(augment_row(row, rng, directional_prob=1.0, region_prob=0.0))
    assert results[0] is row
    assert row["span_starts"] == [0, 4] and row["span_ends"] == [3, 14]


def test_expanded_spans_project_identically_to_expanded_tokens():
    """Gate: on the augmented copy, the spans-based piece stream equals the token-based one."""
    rng = random.Random(42)
    augmented = list(augment_row(_spanned_directional_row(), rng, directional_prob=1.0, region_prob=0.0))[1]
    pieces = []
    cursor = 0
    for tok in augmented["tokens"]:
        idx = augmented["raw"].index(tok, cursor)
        pieces.append(PieceSpan(piece=tok, piece_id=0, char_begin=idx, char_end=idx + len(tok)))
        cursor = idx + len(tok)
    via_tokens = realign_labels_to_pieces(augmented["raw"], augmented["tokens"], augmented["labels"], pieces)
    via_spans = realign_spans_to_pieces(
        augmented["raw"], augmented["span_starts"], augmented["span_ends"], augmented["span_tags"], pieces
    )
    assert via_spans == via_tokens


def test_glue_shifts_spans_with_the_splice():
    row = {
        **_glue_row(),
        "span_starts": [0, 4, 12, 20, 23],
        "span_ends": [3, 11, 19, 22, 28],
        "span_tags": ["house_number", "street", "locality", "region", "postcode"],
    }
    fused = glue_region_postcode(row, 4)
    assert fused["raw"] == "123 Main St Buffalo NY14201"
    assert _slices(fused) == [
        ("house_number", "123"),
        ("street", "Main St"),
        ("locality", "Buffalo"),
        ("region", "NY"),
        ("postcode", "14201"),
    ]
    # The source row's spans are untouched (fresh lists on the copy).
    assert row["span_starts"] == [0, 4, 12, 20, 23]


def test_glue_without_spans_stays_legacy():
    fused = glue_region_postcode(_glue_row(), 4)
    assert "span_starts" not in fused


def test_row_span_triple_partial_raises():
    with pytest.raises(ValueError, match="partial char-offset span triple"):
        row_span_triple({"raw": "x", "span_starts": [0]})


def test_row_span_triple_nonparallel_raises():
    with pytest.raises(ValueError, match="not parallel"):
        row_span_triple({"raw": "x", "span_starts": [0], "span_ends": [1, 2], "span_tags": ["street"]})


# --- Raw splicing for expansions (PR #534 open question 3) ---------------------------------------
# The expansions must never rebuild raw via " ".join(tokens): the join destroys whitespace
# geometry (newlines, double spaces) and re-quantizing spans to token boundaries absorbs
# punctuation the v0.5.0 spans deliberately exclude. The canonical probe is a dotted P.O. Box
# beside a comma-bearing token.


def _dotted_po_box_row() -> dict:
    # raw:  P.O. Box 123, Buffalo NY 14201
    #       0         1         2
    #       0123456789012345678901234567890
    # The po_box span [0, 12) excludes the trailing comma; the comma rides inside the "123,"
    # whitespace token. A token-label re-derive would absorb it into the span.
    return {
        "raw": "P.O. Box 123, Buffalo NY 14201",
        "tokens": ["P.O.", "Box", "123,", "Buffalo", "NY", "14201"],
        "labels": ["B-po_box", "I-po_box", "I-po_box", "B-locality", "B-region", "B-postcode"],
        "span_starts": [0, 14, 22, 25],
        "span_ends": [12, 21, 24, 30],
        "span_tags": ["po_box", "locality", "region", "postcode"],
        "country": "US",
        "source": "test",
    }


def test_expansion_preserves_intra_span_punctuation():
    """The dotted P.O. Box survives the region expansion verbatim — dots inside the span,
    trailing comma still outside it — and every offset addresses the NEW raw exactly."""
    rng = random.Random(42)
    results = list(augment_row(_dotted_po_box_row(), rng, directional_prob=0.0, region_prob=1.0))
    assert len(results) == 2
    augmented = results[1]
    assert augmented["raw"] == "P.O. Box 123, Buffalo New York 14201"
    assert _slices(augmented) == [
        ("po_box", "P.O. Box 123"),
        ("locality", "Buffalo"),
        ("region", "New York"),
        ("postcode", "14201"),
    ]
    _assert_span_invariants(augmented)
    # The comma after the po_box stays in raw, outside the span.
    assert augmented["raw"][12] == ","


def test_expansion_preserves_whitespace_geometry():
    """Newlines + double spaces in raw survive the splice — the exact information a
    " ".join(tokens) rebuild destroys."""
    row = {
        "raw": "350 5th  Ave NW\nBuffalo",
        "tokens": ["350", "5th", "Ave", "NW", "Buffalo"],
        "labels": ["B-house_number", "B-street", "I-street", "I-street", "B-locality"],
        "span_starts": [0, 4, 16],
        "span_ends": [3, 15, 23],
        "span_tags": ["house_number", "street", "locality"],
        "country": "US",
        "source": "test",
    }
    rng = random.Random(42)
    augmented = list(augment_row(row, rng, directional_prob=1.0, region_prob=0.0))[1]
    assert augmented["raw"] == "350 5th  Ave Northwest\nBuffalo"
    assert _slices(augmented) == [
        ("house_number", "350"),
        ("street", "5th  Ave Northwest"),
        ("locality", "Buffalo"),
    ]
    _assert_span_invariants(augmented)


def test_expansion_legacy_row_keeps_punctuation_too():
    """Token-only (pre-v0.5.0) rows ride the same splice: the raw keeps its punctuation even
    though no spans need re-targeting."""
    row = {k: v for k, v in _dotted_po_box_row().items() if not k.startswith("span_")}
    rng = random.Random(42)
    results = list(augment_row(row, rng, directional_prob=0.0, region_prob=1.0))
    assert len(results) == 2
    assert results[1]["raw"] == "P.O. Box 123, Buffalo New York 14201"
    assert "span_starts" not in results[1]


def test_splice_expansion_leaves_the_source_row_alone():
    row = _dotted_po_box_row()
    splice_expansion(row, 4, "New York")
    assert row["raw"] == "P.O. Box 123, Buffalo NY 14201"
    assert row["span_starts"] == [0, 14, 22, 25]
    assert row["tokens"][4] == "NY"


def test_splice_expansion_boundary_inside_edited_token_raises():
    """A span boundary strictly inside the expanded token addresses a surface the splice
    destroys — impossible to re-target, so it raises rather than guesses."""
    row = {
        "raw": "Buffalo NY 14201",
        "tokens": ["Buffalo", "NY", "14201"],
        "labels": ["B-locality", "B-region", "B-postcode"],
        # Corrupt on purpose: the region span covers only the first char of "NY".
        "span_starts": [0, 8, 11],
        "span_ends": [7, 9, 16],
        "span_tags": ["locality", "region", "postcode"],
    }
    with pytest.raises(ValueError, match="un-retargetable"):
        splice_expansion(row, 1, "New York")


def test_expansion_then_glue_compose_still_verifies():
    """Composing the two splices (directional expansion, then region+postcode glue) keeps every
    offset addressing the final raw."""
    row = {
        "raw": "350 5th Ave NW Buffalo, NY 14201",
        "tokens": ["350", "5th", "Ave", "NW", "Buffalo,", "NY", "14201"],
        "labels": ["B-house_number", "B-street", "I-street", "I-street", "B-locality", "B-region", "B-postcode"],
        "span_starts": [0, 4, 15, 24, 27],
        "span_ends": [3, 14, 22, 26, 32],
        "span_tags": ["house_number", "street", "locality", "region", "postcode"],
        "country": "US",
        "source": "test",
    }
    expanded = splice_expansion(row, 3, "Northwest")
    assert expanded["raw"] == "350 5th Ave Northwest Buffalo, NY 14201"
    fused = glue_region_postcode(expanded, 5)
    assert fused["raw"] == "350 5th Ave Northwest Buffalo, NY14201"
    assert _slices(fused) == [
        ("house_number", "350"),
        ("street", "5th Ave Northwest"),
        ("locality", "Buffalo"),
        ("region", "NY"),
        ("postcode", "14201"),
    ]
    _assert_span_invariants(fused)


def test_lowercase_row_preserves_labels_and_spans():
    # Lowercasing is length-preserving, so labels + char-offset spans pass through UNCHANGED.
    row = {
        "raw": "350 5th Ave NW",
        "tokens": ["350", "5th", "Ave", "NW"],
        "labels": ["B-house_number", "B-street", "I-street", "I-street"],
        "span_starts": [0, 4],
        "span_ends": [3, 14],
        "span_tags": ["house_number", "street"],
        "country": "US",
        "source": "tiger",
    }
    out = lowercase_row(row)
    assert out is not None
    assert out["raw"] == "350 5th ave nw"
    assert out["tokens"] == ["350", "5th", "ave", "nw"]
    assert out["labels"] == row["labels"]
    assert out["span_starts"] == row["span_starts"]
    assert out["span_ends"] == row["span_ends"]
    assert out["span_tags"] == row["span_tags"]


def test_lowercase_row_skips_non_length_preserving():
    # Turkish dotted capital İ → 'i̇' (2 chars) would desync char-offset spans, so skip the row.
    row = {"raw": "İSTANBUL", "tokens": ["İSTANBUL"], "labels": ["B-locality"]}
    assert lowercase_row(row) is None


def test_augment_row_case_prob_yields_lowercased_copy():
    row = {
        "raw": "350 5th Ave NW",
        "tokens": ["350", "5th", "Ave", "NW"],
        "labels": ["B-house_number", "B-street", "I-street", "I-street"],
        "country": "US",
        "source": "tiger",
    }
    rng = random.Random(42)
    results = list(augment_row(row, rng, directional_prob=0.0, region_prob=0.0, case_prob=1.0))
    assert results[0] is row  # original first, unchanged
    assert any(r["raw"] == "350 5th ave nw" for r in results)


def test_augment_row_case_prob_zero_is_bit_identical():
    # case_prob=0 must not consume the rng stream (the guard), so it's a no-op vs no case knob.
    row = {
        "raw": "350 5th Ave NW",
        "tokens": ["350", "5th", "Ave", "NW"],
        "labels": ["B-house_number", "B-street", "I-street", "I-street"],
        "country": "US",
        "source": "tiger",
    }
    a = list(augment_row(row, random.Random(7), directional_prob=0.5, region_prob=0.5, case_prob=0.0))
    b = list(augment_row(row, random.Random(7), directional_prob=0.5, region_prob=0.5))
    assert [r["raw"] for r in a] == [r["raw"] for r in b]
