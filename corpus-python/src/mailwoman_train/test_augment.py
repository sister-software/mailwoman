"""Tests for training-time augmentation."""

import random

from .augment import augment_row, glue_region_postcode, _expand_token
from .tokenizer import PieceSpan, realign_labels_to_pieces


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
    """The load-bearing property (#513): the fused surface with SPLIT tokens/labels projects
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
