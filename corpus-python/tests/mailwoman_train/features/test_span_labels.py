"""Invariance checks for the v0.5.0 char-offset label format (#519 — the consult keepers, as tests).

Three checks, pre-registered in the design doc (2026-06-11-char-offset-labels-design.md, affected-surface
items 6 + 8, plus the positive case the migration exists for):

(a) **Label-stream bit-identity** — on rows without intra-span punctuation, the spans-based
    piece-label stream must be BIT-IDENTICAL to the token-based one. Fixtures: plain US row,
    accented FR row (NFC ``é``), multi-span DE row, all-O row.
(b) **Channel invariance** — the anchor channel (gold, from tokens and from spans) and the gazetteer
    painting must produce identical tensors under both paths on those fixtures (the per-piece channels
    key off the same underlying data the migration touches).
(c) **Punctuation inside a span** — a row with intra-span punctuation ("P.O. Box 19", one po_box span
    over chars [0, 11)) must produce the punctuation-covering label stream the token path
    structurally cannot: continuous B/I over the period pieces instead of O-fragmented.

The encoder is the training one, `mailwoman_mtf.RowEncoder`, given explicit pieces (char offsets) so no
SentencePiece model is needed. The Python projection in `tokenizer/spans.py`, which the char path keeps, is
checked against it on every fixture.
"""

from __future__ import annotations

import json
from typing import Any

import mailwoman_mtf
import pytest

from mailwoman_train.data.loader.encode import row_encoder
from mailwoman_train.labels import LABEL_TO_ID
from mailwoman_train.tokenizer import (
    char_label_array_from_spans,
    realign_labels_to_pieces,
    realign_spans_to_pieces,
)
from mailwoman_train.types import PieceSpan


def _pieces(raw: str, chunks: list[str]) -> list[PieceSpan]:
    """Build mock PieceSpans by locating each chunk left-to-right in ``raw``."""
    out: list[PieceSpan] = []
    cursor = 0
    for chunk in chunks:
        idx = raw.index(chunk, cursor)
        out.append(PieceSpan(piece=chunk, piece_id=hash(chunk) % 1000 + 3, char_begin=idx, char_end=idx + len(chunk)))
        cursor = idx + len(chunk)
    return out


def encode_row(
    encoder: mailwoman_mtf.RowEncoder,
    pieces: list[PieceSpan],
    raw: str,
    tokens: list[str],
    labels: list[str],
    *,
    span_starts: list[int] | None = None,
    span_ends: list[int] | None = None,
    span_tags: list[str] | None = None,
) -> dict[str, list[Any]]:
    """One row through the row encoder with the given pieces, every tensor as a list."""
    row = {"raw": raw, "tokens": tokens, "labels": labels}
    if span_starts is not None or span_ends is not None or span_tags is not None:
        row |= {"span_starts": span_starts, "span_ends": span_ends, "span_tags": span_tags}
    batch = encoder.encode_batch([row], pieces=[[(p.piece_id, p.char_begin, p.char_end) for p in pieces]])
    return {name: array[0].tolist() for name, array in batch.items()}


@pytest.fixture(scope="module")
def plain() -> mailwoman_mtf.RowEncoder:
    return row_encoder(None, max_length=32, pad_id=0)


@pytest.fixture(scope="module")
def channels(tmp_path_factory: pytest.TempPathFactory) -> mailwoman_mtf.RowEncoder:
    root = tmp_path_factory.mktemp("span-labels")
    anchor = root / "anchor.json"
    anchor.write_text(json.dumps({k: list(v) for k, v in ANCHOR_LOOKUP.items()}), encoding="utf-8")
    lexicon = root / "lexicon.json"
    lexicon.write_text(json.dumps(LEXICON), encoding="utf-8")
    return row_encoder(
        None, max_length=32, pad_id=0, anchor_lookup_path=str(anchor), gazetteer_lexicon_path=str(lexicon)
    )


# endregion

# region Fixtures: rows without intra-span punctuation, in both label representations

# Each: (name, raw, tokens, labels, span_starts, span_ends, span_tags, piece_chunks).
# Piece chunks deliberately split inside words (Pennsylv|ania, Républi|que, Ber|lin) to exercise
# the B→I flip. Separator commas get their own piece to pin the "comma outside both spans"
# behavior on both paths.
FIXTURES = [
    (
        "plain-us",
        "1600 Pennsylvania Ave NW, Washington, DC 20500",
        ["1600", "Pennsylvania", "Ave", "NW", "Washington", "DC", "20500"],
        ["B-house_number", "B-street", "I-street", "I-street", "B-locality", "B-region", "B-postcode"],
        [0, 5, 26, 38, 41],
        [4, 24, 36, 40, 46],
        ["house_number", "street", "locality", "region", "postcode"],
        ["1600", "Pennsylv", "ania", "Ave", "NW", ",", "Washington", ",", "DC", "20500"],
    ),
    (
        "accented-fr",  # NFC é — one code unit. offsets address the composed form.
        "10 Rue de la République, 75008 Paris",
        ["10", "Rue", "de", "la", "République", "75008", "Paris"],
        ["B-house_number", "B-street", "I-street", "I-street", "I-street", "B-postcode", "B-locality"],
        [0, 3, 25, 31],
        [2, 23, 30, 36],
        ["house_number", "street", "postcode", "locality"],
        ["10", "Rue", "de", "la", "Républi", "que", ",", "75008", "Paris"],
    ),
    (
        "multi-span-de",
        "Strasse 12 10115 Berlin",
        ["Strasse", "12", "10115", "Berlin"],
        ["B-street", "B-house_number", "B-postcode", "B-locality"],
        [0, 8, 11, 17],
        [7, 10, 16, 23],
        ["street", "house_number", "postcode", "locality"],
        ["Strasse", "12", "101", "15", "Ber", "lin"],
    ),
    (
        "all-o",
        "hello unlabeled world",
        ["hello", "unlabeled", "world"],
        ["O", "O", "O"],
        [],
        [],
        [],
        ["hello", "unlab", "eled", "world"],
    ),
]

ANCHOR_LOOKUP = {
    "10115": ({"DE": 1.0}, 52.53, 13.40),
    "20500": ({"US": 1.0}, 38.90, -77.04),
    "75008": ({"FR": 1.0}, 48.87, 2.32),
}

# Tiny lexicon: enough surface hits (DC code, Berlin/Paris/Washington names) to make the
# gazetteer tensors non-trivial on the fixtures.
LEXICON = {
    "feature_dim": 2,
    "slots": ["region", "locality_homograph"],
    "bits": {"region": 1, "locality_homograph": 2},
    "max_ngram": 2,
    "entries": {"berlin": 2, "paris": 2, "washington": 2},
    "code_entries": {"DC": 1},
}


def _fixture_sanity(raw, tokens, labels, span_starts, span_ends, span_tags):
    """The two representations must describe the same row before identity means anything."""
    assert len(tokens) == len(labels)
    assert len(span_starts) == len(span_ends) == len(span_tags)
    for start, end in zip(span_starts, span_ends, strict=True):
        assert 0 <= start < end <= len(raw)


# endregion

# region Check (a): label-stream bit-identity on punctuation-free rows


@pytest.mark.parametrize("name,raw,tokens,labels,starts,ends,tags,chunks", FIXTURES)
def test_check_a_label_stream_bit_identical(name, raw, tokens, labels, starts, ends, tags, chunks):
    _fixture_sanity(raw, tokens, labels, starts, ends, tags)
    pieces = _pieces(raw, chunks)
    token_stream = realign_labels_to_pieces(raw, tokens, labels, pieces)
    span_stream = realign_spans_to_pieces(raw, starts, ends, tags, pieces)
    assert span_stream == token_stream, f"{name}: spans-based stream diverged from token-based"


@pytest.mark.parametrize("name,raw,tokens,labels,starts,ends,tags,chunks", FIXTURES)
def test_check_a_encode_row_bit_identical(plain, name, raw, tokens, labels, starts, ends, tags, chunks):
    """Full encoder output (ids + mask + label ids, padded) identical under both paths."""
    pieces = _pieces(raw, chunks)
    via_tokens = encode_row(plain, pieces, raw, tokens, labels)
    via_spans = encode_row(plain, pieces, raw, tokens, labels, span_starts=starts, span_ends=ends, span_tags=tags)
    assert via_spans == via_tokens, f"{name}: encoder outputs diverged"


@pytest.mark.parametrize("name,raw,tokens,labels,starts,ends,tags,chunks", FIXTURES)
def test_the_encoder_projects_labels_as_the_python_projection_does(
    plain, name, raw, tokens, labels, starts, ends, tags, chunks
):
    """The char path keeps `tokenizer/spans.py`, so the two projections must agree."""
    pieces = _pieces(raw, chunks)
    n = len(pieces)
    via_spans = encode_row(plain, pieces, raw, tokens, labels, span_starts=starts, span_ends=ends, span_tags=tags)
    assert via_spans["labels"][:n] == [LABEL_TO_ID[x] for x in realign_spans_to_pieces(raw, starts, ends, tags, pieces)]
    via_tokens = encode_row(plain, pieces, raw, tokens, labels)
    assert via_tokens["labels"][:n] == [LABEL_TO_ID[x] for x in realign_labels_to_pieces(raw, tokens, labels, pieces)]


# endregion

# region Check (b): anchor + gazetteer channel invariance


@pytest.mark.parametrize("name,raw,tokens,labels,starts,ends,tags,chunks", FIXTURES)
def test_check_b_channels_identical_through_the_encoder(
    channels, name, raw, tokens, labels, starts, ends, tags, chunks
):
    """Anchor + gazetteer tensors identical through the full encoder, both label sources."""
    pieces = _pieces(raw, chunks)
    via_tokens = encode_row(channels, pieces, raw, tokens, labels)
    via_spans = encode_row(channels, pieces, raw, tokens, labels, span_starts=starts, span_ends=ends, span_tags=tags)
    for key in ("anchor_features", "anchor_confidence", "gazetteer_features", "gazetteer_confidence"):
        assert via_spans[key] == via_tokens[key], f"{name}: {key} diverged"
    if "postcode" in tags:
        assert any(c > 0 for c in via_spans["anchor_confidence"]), f"{name}: anchor never fired — vacuous check"


def test_check_b_gazetteer_painting_fires_on_fixtures(channels):
    """Anti-vacuity: the gazetteer clue is set on at least one fixture piece."""
    raw = "Strasse 12 10115 Berlin"
    out = encode_row(channels, _pieces(raw, ["Strasse", "12", "101", "15", "Ber", "lin"]), raw, [], [])
    confs = out["gazetteer_confidence"]
    assert any(c > 0 for c in confs)  # "Berlin" matched
    assert out["gazetteer_features"][confs.index(1.0)] == [0.0, 1.0]  # locality_homograph bit


# endregion

# region Check (c): the punctuation-covering stream the token path cannot produce


# "P.O. Box 19" — one po_box span over chars [0, 11) (the whole surface). Pieces give each
# period its own piece: the token path's per-char array has O on the periods (the corpus
# tokenizer dropped them), so the stream fragments. the span path covers them.
PO_RAW = "P.O. Box 19"
PO_TOKENS = ["P", "O", "Box", "19"]
PO_LABELS = ["B-po_box", "I-po_box", "I-po_box", "I-po_box"]
PO_SPANS = ([0], [11], ["po_box"])
PO_CHUNKS = ["P", ".", "O", ".", "Box", "19"]


def test_check_c_token_path_fragments_on_dotted_designator():
    pieces = _pieces(PO_RAW, PO_CHUNKS)
    token_stream = realign_labels_to_pieces(PO_RAW, PO_TOKENS, PO_LABELS, pieces)
    # The structural blind spot, pinned: periods fall to O, splitting the entity in three.
    assert token_stream == ["B-po_box", "O", "B-po_box", "O", "B-po_box", "I-po_box"]


def test_check_c_span_path_covers_the_punctuation():
    pieces = _pieces(PO_RAW, PO_CHUNKS)
    starts, ends, tags = PO_SPANS
    span_stream = realign_spans_to_pieces(PO_RAW, starts, ends, tags, pieces)
    # One continuous entity, periods included — the stream the migration exists for.
    assert span_stream == ["B-po_box", "I-po_box", "I-po_box", "I-po_box", "I-po_box", "I-po_box"]
    token_stream = realign_labels_to_pieces(PO_RAW, PO_TOKENS, PO_LABELS, pieces)
    assert span_stream != token_stream


def test_check_c_through_the_encoder(plain):
    pieces = _pieces(PO_RAW, PO_CHUNKS)
    starts, ends, tags = PO_SPANS
    via_tokens = encode_row(plain, pieces, PO_RAW, PO_TOKENS, PO_LABELS)
    via_spans = encode_row(
        plain, pieces, PO_RAW, PO_TOKENS, PO_LABELS, span_starts=starts, span_ends=ends, span_tags=tags
    )
    assert via_spans["labels"] != via_tokens["labels"]
    assert via_spans["input_ids"] == via_tokens["input_ids"]  # only the labels differ


# endregion

# region Loud invariant enforcement


def test_span_arrays_length_mismatch_raises():
    with pytest.raises(ValueError, match="length mismatch"):
        char_label_array_from_spans("abc def", [0], [3, 7], ["street"])


def test_unsorted_spans_raise():
    with pytest.raises(ValueError, match="not sorted"):
        char_label_array_from_spans("abc def", [4, 0], [7, 3], ["street", "house_number"])


def test_overlapping_spans_raise():
    with pytest.raises(ValueError, match="overlap"):
        char_label_array_from_spans("abc def", [0, 2], [3, 7], ["street", "locality"])


def test_out_of_bounds_span_raises():
    with pytest.raises(ValueError, match="out of bounds"):
        char_label_array_from_spans("abc", [0], [4], ["street"])


def test_partial_span_kwargs_raise(plain):
    with pytest.raises(ValueError, match="supplied together"):
        encode_row(plain, _pieces("abc", ["abc"]), "abc", ["abc"], ["O"], span_starts=[0])
