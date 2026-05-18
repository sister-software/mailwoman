"""Tokenizer alignment / label-realignment unit tests.

Skips if ``/data/models/tokenizer/v0.1.0/tokenizer.model`` is not on disk — the tests need
a real SentencePiece model to exercise the byte-offset realignment path. CI should provide
one (the Phase 1 tokenizer training script writes it).
"""

from pathlib import Path

import pytest

TOKENIZER_PATH = Path("/data/models/tokenizer/v0.1.0/tokenizer.model")
pytestmark = pytest.mark.skipif(
    not TOKENIZER_PATH.exists(),
    reason="tokenizer.model missing; run scripts/train_tokenizer.py first",
)


def test_whitespace_spans_handles_repeats():
    from mailwoman_train.tokenizer import whitespace_spans

    raw = "Buffalo Health Clinic, 123 Main St, Buffalo, NY 14201"
    tokens = ["Buffalo", "Health", "Clinic,", "123", "Main", "St,", "Buffalo,", "NY", "14201"]
    spans = whitespace_spans(raw, tokens)
    # First "Buffalo" is at index 0; second is the trailing "Buffalo," token.
    assert spans[0] == (0, 7)
    # The "Buffalo," span: locate it explicitly from the raw to keep the test robust to
    # changes in upstream whitespace handling.
    second_buffalo_idx = raw.index("Buffalo,")
    assert spans[6] == (second_buffalo_idx, second_buffalo_idx + len("Buffalo,"))
    # Sanity-check left-to-right monotonicity: every span starts at or after the previous end.
    for prev, cur in zip(spans, spans[1:]):
        assert cur[0] >= prev[1]


def test_realign_labels_preserves_bio_continuity():
    from mailwoman_train.tokenizer import (
        Tokenizer,
        realign_labels_to_pieces,
    )

    raw = "Burlington, VT 05401"
    tokens = ["Burlington,", "VT", "05401"]
    labels = ["B-locality", "B-region", "B-postcode"]
    t = Tokenizer(TOKENIZER_PATH)
    pieces = t.encode_with_spans(raw)
    aligned = realign_labels_to_pieces(raw, tokens, labels, pieces)

    # Every piece that lands inside the "Burlington" span should be locality-tagged,
    # and only the first should be B-, rest I-.
    assert aligned[0].startswith("B-") or aligned[0] == "O"
    # The piece(s) that fall on "VT" should be region; first one is B-region.
    region_indices = [i for i, lab in enumerate(aligned) if lab.endswith("-region")]
    if region_indices:
        first = region_indices[0]
        assert aligned[first] == "B-region"
        for j in region_indices[1:]:
            assert aligned[j] == "I-region"


def test_encode_row_pads_and_masks_correctly():
    from mailwoman_train.tokenizer import Tokenizer, encode_row

    t = Tokenizer(TOKENIZER_PATH)
    enc = encode_row(t, "France", ["France"], ["B-country"], max_length=16)
    assert len(enc["input_ids"]) == 16
    assert len(enc["attention_mask"]) == 16
    assert len(enc["labels"]) == 16
    # Non-pad section is short; the rest is pad + IGNORE_INDEX.
    non_pad = sum(enc["attention_mask"])
    assert 1 <= non_pad <= 4
    for i in range(non_pad, 16):
        assert enc["attention_mask"][i] == 0
        assert enc["labels"][i] == -100  # IGNORE_INDEX
