"""One row encoded with every soft-feed channel on, pinned key by key.

The channel tests beside this one exercise the COLLATE — what `to_tensor_batch` does with the keys
`encode_row` produced. The assembly itself had no test with more than one channel on: the anchor
had its own, and the four that follow it were reached only through a training run.

Each channel truncates to `max_length` and zero-pads both halves to the width the labels use, and
the gazetteer's choreography reads the anchor's confidence out of the dict the anchor block wrote.
So the blocks are not independent: their ORDER is what makes the choreography see an anchor, and a
width that pads wrong shows up as a tensor the collate cannot stack rather than as a wrong number.

The tokenizer here is a stub rather than a `skipif` on the real SentencePiece model. A skip on a
missing artifact reads exactly like a clean result, and this test would then be green on every
machine that does not have `/data/models/tokenizer/v0.1.0/tokenizer.model` — which is all of CI.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from mailwoman_train.features.gazetteer_anchor import GazetteerLexicon
from mailwoman_train.tokenizer.encode import encode_row
from mailwoman_train.types import PieceSpan

#: Committed beside this file, captured from the code as it stood BEFORE a split.
#:
#: Regenerate with: uv run python -m tests.mailwoman_train.tokenizer.test_encode_row_channels
REFERENCE = Path(__file__).parent / "encode-row-channels-reference.json"

#: The row every case encodes. It carries a postcode the anchor lexicon knows, a locality the
#: gazetteer knows, a country surface, a street type and a locality surface — one hit per channel,
#: so a channel that stops painting shows as zeros rather than as an unchanged result.
#: The postcode carries no trailing punctuation: the anchor's lookup key is the span's raw surface
#: space-stripped and uppercased, so "05401," is a miss and the channel would pin as all zeros.
RAW = "12 Market St, Burlington, VT 05401 USA"
TOKENS = ["12", "Market", "St,", "Burlington,", "VT", "05401", "USA"]
LABELS = ["B-house_number", "B-street", "I-street", "B-locality", "B-region", "B-postcode", "B-country"]

MAX_LENGTH = 24


@dataclass(frozen=True)
class StubTokenizer:
    """Enough of `Tokenizer` for `encode_row`: pieces with char offsets, and a pad id.

    Splits on whitespace and then on each non-alphanumeric character, which produces the
    intra-span punctuation pieces the span label path exists to cover — a comma inside
    "Burlington," is its own piece here, as it is under SentencePiece.
    """

    pad_id: int = 0

    def encode_with_spans(self, raw: str) -> list[PieceSpan]:
        pieces: list[PieceSpan] = []
        start: int | None = None
        for index, char in enumerate([*raw, " "]):
            if char.isalnum():
                start = index if start is None else start
                continue
            if start is not None:
                pieces.append(self._piece(raw, start, index))
                start = None
            if index < len(raw) and not char.isspace():
                pieces.append(self._piece(raw, index, index + 1))
        return pieces

    @staticmethod
    def _piece(raw: str, begin: int, end: int) -> PieceSpan:
        text = raw[begin:end]
        # A stable id per surface form, so the pinned input_ids say which piece landed where.
        return PieceSpan(piece=text, piece_id=1 + sum(ord(c) for c in text) % 997, char_begin=begin, char_end=end)


def lexicon(slots: tuple[str, ...], entries: dict[str, int]) -> GazetteerLexicon:
    """A lexicon over `slots`, each entry naming the bits it paints."""
    bits = {slot: 1 << i for i, slot in enumerate(slots)}
    return GazetteerLexicon(
        feature_dim=len(slots),
        slots=slots,
        bits=bits,
        max_ngram=1,
        entries=entries,
        code_entries={},
    )


#: Postcode -> ({country: weight}, lat, lon), the shape `realign_anchor_to_pieces` looks up.
ANCHOR_LOOKUP: dict[str, tuple[dict[str, float], float, float]] = {"05401": ({"US": 1.0}, 44.4759, -73.2121)}

GAZETTEER = lexicon(("locality", "region", "country"), {"burlington": 0b001, "vt": 0b010, "usa": 0b100})
COUNTRY = lexicon(("country_surface", "country_ambiguous"), {"usa": 0b01, "vt": 0b11})
STREET_TYPE = lexicon(("street_type",), {"st": 0b1})
LOCALITY_SURFACE = lexicon(("locality", "locality_homograph"), {"burlington": 0b01, "market": 0b11})


def encode(**overrides: Any) -> dict[str, list[Any]]:
    kwargs: dict[str, Any] = {
        "anchor_lookup": ANCHOR_LOOKUP,
        "gazetteer_lexicon": GAZETTEER,
        "gazetteer_choreography": True,
        "country_lexicon": COUNTRY,
        "street_type_lexicon": STREET_TYPE,
        "locality_surface_lexicon": LOCALITY_SURFACE,
    }
    kwargs.update(overrides)
    return encode_row(StubTokenizer(), RAW, TOKENS, LABELS, MAX_LENGTH, **kwargs)


def all_channels() -> dict[str, dict[str, list[Any]]]:
    """The two label sources, each with every channel on.

    The span path and the token path reach different anchor painters and different label arrays, so
    a change that moves one and not the other is a change one of them does not describe.
    """
    starts, ends, tags = [], [], []
    for token, label in zip(TOKENS, LABELS, strict=True):
        if label.startswith("B-"):
            begin = RAW.index(token)
            starts.append(begin)
            ends.append(begin + len(token.rstrip(",")))
            tags.append(label[2:])
    return {
        "tokens": encode(),
        "spans": encode(span_starts=starts, span_ends=ends, span_tags=tags),
        "shaped_anchor": encode(anchor_paint_mode="shaped"),
        "no_channels": encode(
            anchor_lookup=None,
            gazetteer_lexicon=None,
            country_lexicon=None,
            street_type_lexicon=None,
            locality_surface_lexicon=None,
        ),
    }


@pytest.fixture(scope="module")
def encoded() -> dict[str, dict[str, list[Any]]]:
    return all_channels()


@pytest.mark.parametrize("case", ["tokens", "spans", "shaped_anchor", "no_channels"])
def test_the_encoding_matches_the_committed_reference(encoded: dict[str, Any], case: str) -> None:
    expected = json.loads(REFERENCE.read_text())[case]
    actual = encoded[case]
    assert sorted(actual) == sorted(expected), f"{case}: the emitted keys changed"
    drifted = [key for key in expected if actual[key] != expected[key]]
    assert drifted == [], f"{case}: {drifted} moved"


@pytest.mark.parametrize("case", ["tokens", "spans", "shaped_anchor"])
def test_every_channel_pads_to_the_label_width(encoded: dict[str, Any], case: str) -> None:
    """A channel padded to a different width is a tensor the collate cannot stack."""
    actual = encoded[case]
    for key, value in actual.items():
        assert len(value) == MAX_LENGTH, f"{case}: {key} is {len(value)} wide, not {MAX_LENGTH}"


def test_a_row_without_channels_carries_only_the_three_base_keys(encoded: dict[str, Any]) -> None:
    """Absent channels are OMITTED, which is what keeps a pre-channel recipe byte-identical."""
    assert set(encoded["no_channels"]) == {"input_ids", "attention_mask", "labels"}


def test_the_fixture_paints_every_channel(encoded: dict[str, Any]) -> None:
    """A lexicon that matched nothing would pin zeros and measure none of the painting."""
    actual = encoded["tokens"]
    for key in (
        "anchor_features",
        "gazetteer_features",
        "country_features",
        "street_type_features",
        "locality_surface_features",
    ):
        assert any(any(row) for row in actual[key]), f"{key} painted nothing"


def write_reference() -> None:
    """Capture the current encoding as the reference the tests above compare against.

    Run this only when the current code already passes against the existing reference — otherwise
    the artifact records whatever the code does now, and the tests assert nothing.
    """
    payload = {
        "README": [
            "Pins one row encoded with every soft-feed channel on, across a refactor.",
            "Regenerate: uv run python -m tests.mailwoman_train.tokenizer.test_encode_row_channels",
            "Fixture: StubTokenizer and four lexicons in the test beside this file.",
        ],
        **all_channels(),
    }
    REFERENCE.write_text(json.dumps(payload, ensure_ascii=False, indent="\t") + "\n")
    print(f"wrote {REFERENCE}")


if __name__ == "__main__":
    write_reference()
