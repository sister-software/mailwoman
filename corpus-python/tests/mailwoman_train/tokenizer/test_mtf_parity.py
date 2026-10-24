"""The training tokenizer reproduces @mailwoman/mtf's pieces and char ranges on every board input.

Training labels and serving offsets come from two implementations: `Tokenizer.encode_with_spans`
here and `@mailwoman/mtf` in the parser. The committed fixture
`packages/mtf/test/fixtures/board-reference-v0.2.2.json` holds the serving side's IDs, pieces and
UTF-8 byte offsets for the shipped model, so a label the projection gives a piece lands on the same
characters at inference. The shipped model is not committed, so the test reads it through the data
root and skips, naming the path, on a host without it.
"""

from __future__ import annotations

import json

import pytest

from mailwoman_train.env import MissingEnvironmentError
from mailwoman_train.paths import data_root_path, repo_root_path
from mailwoman_train.tokenizer import Tokenizer

FIXTURE = repo_root_path("packages", "mtf", "test", "fixtures", "board-reference-v0.2.2.json")

try:
    MODEL = data_root_path("models", "tokenizer", "v0.9.0-multisplice", "tokenizer.model")
    _SKIP = None if MODEL.exists() else f"shipped tokenizer model absent at {MODEL}"
except MissingEnvironmentError:
    _SKIP = "MAILWOMAN_DATA_ROOT is unset, so the shipped tokenizer model cannot be located"

pytestmark = pytest.mark.skipif(_SKIP is not None, reason=_SKIP or "")


def byte_to_char(raw: str) -> list[int]:
    out: list[int] = []
    for index, char in enumerate(raw):
        out.extend([index] * len(char.encode("utf-8")))
    out.append(len(raw))
    return out


def test_pieces_and_char_ranges_match_the_serving_tokenizer() -> None:
    rows = json.loads(FIXTURE.read_text())["rows"]
    tokenizer = Tokenizer(MODEL)
    assert rows

    for row in rows:
        raw = row["text"]
        b2c = byte_to_char(raw)
        expected = [
            (piece_id, piece, b2c[begin], b2c[end])
            for piece_id, piece, begin, end in zip(row["ids"], row["pieces"], row["begins"], row["ends"], strict=True)
        ]
        got = [(s.piece_id, s.piece, s.char_begin, s.char_end) for s in tokenizer.encode_with_spans(raw)]
        assert got == expected, raw
