"""Invariance gates for the v0.5.0 char-offset label format (#519 — the consult keepers, as tests).

Three gates, pre-registered in the design doc (2026-06-11-char-offset-labels-design.md, blast-radius
items 6 + 8, plus the positive case the migration exists for):

(a) **Label-stream bit-identity** — on rows WITHOUT intra-span punctuation, the spans-based
    piece-label stream must be BIT-IDENTICAL to the token-based one. Fixtures: plain US row,
    accented FR row (NFC ``é``), multi-span DE row, all-O row.
(b) **Channel invariance** — the anchor channel (``realign_anchor_to_pieces`` vs the spans
    sibling) and the gazetteer painting must produce IDENTICAL tensors under both paths on those
    fixtures (the per-piece channels key off the same substrate the migration touches).
(c) **The punctuation win** — a row WITH intra-span punctuation ("P.O. Box 19", one po_box span
    over chars [0, 11)) must produce the punctuation-covering label stream the token path
    structurally cannot: continuous B/I over the period pieces instead of O-fragmented.

Uses mock ``PieceSpan``s (explicit char offsets, the ``test_anchor_alignment`` pattern) so no
SentencePiece model is needed — torch-free, runnable locally and via the Modal ``run_tests``
entrypoint.
"""

from __future__ import annotations

import pytest

from mailwoman_train.gazetteer_anchor import GazetteerLexicon, realign_gazetteer_to_pieces
from mailwoman_train.tokenizer import (
    PieceSpan,
    char_label_array_from_spans,
    encode_row,
    realign_anchor_to_pieces,
    realign_anchor_to_pieces_from_spans,
    realign_labels_to_pieces,
    realign_spans_to_pieces,
)


def _pieces(raw: str, chunks: list[str]) -> list[PieceSpan]:
    """Build mock PieceSpans by locating each chunk left-to-right in ``raw``."""
    out: list[PieceSpan] = []
    cursor = 0
    for chunk in chunks:
        idx = raw.index(chunk, cursor)
        out.append(PieceSpan(piece=chunk, piece_id=hash(chunk) % 1000 + 3, char_begin=idx, char_end=idx + len(chunk)))
        cursor = idx + len(chunk)
    return out


class FakeTokenizer:
    """Duck-typed stand-in for ``Tokenizer``: fixed pieces, pad_id 0."""

    pad_id = 0

    def __init__(self, pieces: list[PieceSpan]) -> None:
        self._pieces = pieces

    def encode_with_spans(self, raw: str) -> list[PieceSpan]:
        return list(self._pieces)


# --- Fixtures: rows WITHOUT intra-span punctuation, in both label representations -----------
# Each: (name, raw, tokens, labels, span_starts, span_ends, span_tags, piece_chunks).
# Piece chunks deliberately split inside words (Pennsylv|ania, Républi|que, Ber|lin) to exercise
# the B→I flip, and give separator commas their own piece to pin the "comma outside both spans"
# behavior on BOTH paths.
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
        "accented-fr",  # NFC é — one code unit; offsets address the composed form.
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

# Tiny in-memory lexicon: enough surface hits (DC code, Berlin/Paris/Washington names) to make the
# gazetteer tensors non-trivial on the fixtures.
LEXICON = GazetteerLexicon(
    feature_dim=2,
    slots=("region", "locality_homograph"),
    bits={"region": 1, "locality_homograph": 2},
    max_ngram=2,
    entries={"berlin": 2, "paris": 2, "washington": 2},
    code_entries={"DC": 1},
)


def _fixture_sanity(raw, tokens, labels, span_starts, span_ends, span_tags):
    """The two representations must describe the same row before identity means anything."""
    assert len(tokens) == len(labels)
    assert len(span_starts) == len(span_ends) == len(span_tags)
    for start, end in zip(span_starts, span_ends):
        assert 0 <= start < end <= len(raw)


# --- Gate (a): label-stream bit-identity on punctuation-free rows ---------------------------


@pytest.mark.parametrize("name,raw,tokens,labels,starts,ends,tags,chunks", FIXTURES)
def test_gate_a_label_stream_bit_identical(name, raw, tokens, labels, starts, ends, tags, chunks):
    _fixture_sanity(raw, tokens, labels, starts, ends, tags)
    pieces = _pieces(raw, chunks)
    token_stream = realign_labels_to_pieces(raw, tokens, labels, pieces)
    span_stream = realign_spans_to_pieces(raw, starts, ends, tags, pieces)
    assert span_stream == token_stream, f"{name}: spans-based stream diverged from token-based"


@pytest.mark.parametrize("name,raw,tokens,labels,starts,ends,tags,chunks", FIXTURES)
def test_gate_a_encode_row_bit_identical(name, raw, tokens, labels, starts, ends, tags, chunks):
    """Full encode_row output (ids + mask + label ids, padded) identical under both paths."""
    tok = FakeTokenizer(_pieces(raw, chunks))
    via_tokens = encode_row(tok, raw, tokens, labels, max_length=32)
    via_spans = encode_row(tok, raw, tokens, labels, max_length=32, span_starts=starts, span_ends=ends, span_tags=tags)
    assert via_spans == via_tokens, f"{name}: encode_row outputs diverged"


# --- Gate (b): anchor + gazetteer channel invariance ----------------------------------------


@pytest.mark.parametrize("name,raw,tokens,labels,starts,ends,tags,chunks", FIXTURES)
def test_gate_b_anchor_channel_identical(name, raw, tokens, labels, starts, ends, tags, chunks):
    pieces = _pieces(raw, chunks)
    feats_tok, confs_tok = realign_anchor_to_pieces(raw, tokens, labels, pieces, ANCHOR_LOOKUP)
    feats_spn, confs_spn = realign_anchor_to_pieces_from_spans(raw, starts, ends, tags, pieces, ANCHOR_LOOKUP)
    assert confs_spn == confs_tok, f"{name}: anchor confidence diverged"
    assert feats_spn == feats_tok, f"{name}: anchor features diverged"
    if "postcode" in tags:
        assert any(c > 0 for c in confs_spn), f"{name}: anchor never fired — vacuous gate"


@pytest.mark.parametrize("name,raw,tokens,labels,starts,ends,tags,chunks", FIXTURES)
def test_gate_b_channels_identical_through_encode_row(name, raw, tokens, labels, starts, ends, tags, chunks):
    """Anchor + gazetteer tensors identical through the full encode_row, both label sources."""
    tok = FakeTokenizer(_pieces(raw, chunks))
    kwargs = dict(max_length=32, anchor_lookup=ANCHOR_LOOKUP, gazetteer_lexicon=LEXICON)
    via_tokens = encode_row(tok, raw, tokens, labels, **kwargs)
    via_spans = encode_row(
        tok, raw, tokens, labels, span_starts=starts, span_ends=ends, span_tags=tags, **kwargs
    )
    for key in ("anchor_features", "anchor_confidence", "gazetteer_features", "gazetteer_confidence"):
        assert via_spans[key] == via_tokens[key], f"{name}: {key} diverged"


def test_gate_b_gazetteer_painting_fires_on_fixtures():
    """Anti-vacuity: the gazetteer clue actually lights up on at least one fixture piece."""
    raw = "Strasse 12 10115 Berlin"
    pieces = _pieces(raw, ["Strasse", "12", "101", "15", "Ber", "lin"])
    feats, confs = realign_gazetteer_to_pieces(raw, pieces, LEXICON)
    assert any(c > 0 for c in confs)  # "Berlin" matched
    assert feats[confs.index(1.0)] == [0.0, 1.0]  # locality_homograph bit


# --- Gate (c): the punctuation-covering stream the token path cannot produce ----------------

# "P.O. Box 19" — one po_box span over chars [0, 11) (the whole surface). Pieces give each
# period its own piece: the token path's per-char array has O on the periods (the corpus
# tokenizer dropped them), so the stream FRAGMENTS; the span path covers them.
PO_RAW = "P.O. Box 19"
PO_TOKENS = ["P", "O", "Box", "19"]
PO_LABELS = ["B-po_box", "I-po_box", "I-po_box", "I-po_box"]
PO_SPANS = ([0], [11], ["po_box"])
PO_CHUNKS = ["P", ".", "O", ".", "Box", "19"]


def test_gate_c_token_path_fragments_on_dotted_designator():
    pieces = _pieces(PO_RAW, PO_CHUNKS)
    token_stream = realign_labels_to_pieces(PO_RAW, PO_TOKENS, PO_LABELS, pieces)
    # The structural blind spot, pinned: periods fall to O, splitting the entity in three.
    assert token_stream == ["B-po_box", "O", "B-po_box", "O", "B-po_box", "I-po_box"]


def test_gate_c_span_path_covers_the_punctuation():
    pieces = _pieces(PO_RAW, PO_CHUNKS)
    starts, ends, tags = PO_SPANS
    span_stream = realign_spans_to_pieces(PO_RAW, starts, ends, tags, pieces)
    # One continuous entity, periods included — the stream the migration exists for.
    assert span_stream == ["B-po_box", "I-po_box", "I-po_box", "I-po_box", "I-po_box", "I-po_box"]
    token_stream = realign_labels_to_pieces(PO_RAW, PO_TOKENS, PO_LABELS, pieces)
    assert span_stream != token_stream


def test_gate_c_through_encode_row():
    tok = FakeTokenizer(_pieces(PO_RAW, PO_CHUNKS))
    starts, ends, tags = PO_SPANS
    via_tokens = encode_row(tok, PO_RAW, PO_TOKENS, PO_LABELS, max_length=16)
    via_spans = encode_row(
        tok, PO_RAW, PO_TOKENS, PO_LABELS, max_length=16, span_starts=starts, span_ends=ends, span_tags=tags
    )
    assert via_spans["labels"] != via_tokens["labels"]
    assert via_spans["input_ids"] == via_tokens["input_ids"]  # only the labels differ


# --- Loud invariant enforcement --------------------------------------------------------------


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


def test_partial_span_kwargs_raise():
    tok = FakeTokenizer(_pieces("abc", ["abc"]))
    with pytest.raises(ValueError, match="supplied together"):
        encode_row(tok, "abc", ["abc"], ["O"], max_length=8, span_starts=[0])
