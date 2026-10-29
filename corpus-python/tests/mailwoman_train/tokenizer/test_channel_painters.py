"""The anchor, gazetteer and country painters, through `mailwoman_mtf.RowEncoder` with explicit pieces.

These cases come from the Python painters' tests, kept with their inputs and expected values when the painters
moved to `packages/mtf/crates/mtf-channels`. Pieces are passed explicitly, so each case fixes where a value lands.
A case that reads per-character paint passes one piece per character.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import mailwoman_mtf
import numpy as np
import pytest

from mailwoman_train.data.loader.encode import row_encoder
from mailwoman_train.labels import LOCALE_TO_ID, NUM_LOCALES

ANCHOR_DIM = NUM_LOCALES + 2

GAZETTEER_BITS = {"country": 1, "region": 2, "po_box": 4, "cedex": 8, "homograph": 16}
GAZETTEER = {
    "feature_dim": 5,
    "slots": list(GAZETTEER_BITS),
    "bits": GAZETTEER_BITS,
    "max_ngram": 3,
    "entries": {
        "georgia": 1 | 2 | 16,
        "jordan": 1 | 2 | 16,
        "france": 1,
        "costa rica": 1,
        "timor-leste": 1,
        "united states": 1,
        "po box": 4,
        "box": 4,
        "cedex": 8,
    },
    "code_entries": {"CA": 1 | 2 | 16, "IN": 1 | 2 | 16, "TX": 2, "FR": 1},
}

S, A = 1, 2
COUNTRY = {
    "feature_dim": 2,
    "slots": ["country_surface", "country_ambiguous"],
    "bits": {"country_surface": S, "country_ambiguous": A},
    "max_ngram": 4,
    "entries": {
        "united states of america": S,
        "united states": S,
        "america": S | A,
        "france": S,
        "georgia": S | A,
        "costa rica": S,
    },
    "code_entries": {"USA": S, "US": S, "CA": S | A, "FR": S},
}


def write(tmp_path: Path, name: str, document: Any) -> str:
    path = tmp_path / f"{name}.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    return str(path)


def encode(
    encoder: mailwoman_mtf.RowEncoder, raw: str, pieces: list[tuple[int, int]], **row: Any
) -> dict[str, np.ndarray]:
    batch = encoder.encode_batch(
        [{"raw": raw, "tokens": row.pop("tokens", []), "labels": row.pop("labels", []), **row}],
        pieces=[[(0, begin, end) for begin, end in pieces]],
    )
    n = len(pieces)
    return {name: array[0][:n] for name, array in batch.items()}


def anchor_vector(posterior: dict[str, float], lat: float, lon: float) -> np.ndarray:
    """The anchor feature vector the Python painter produced, as float32."""
    vec = [0.0] * NUM_LOCALES
    total = 0.0
    for country, weight in posterior.items():
        if country in LOCALE_TO_ID:
            vec[LOCALE_TO_ID[country]] = weight
            total += weight
    vec = [v / total for v in vec] if total > 0 else vec
    return np.array([*vec, max(-1.0, min(1.0, lat / 90.0)), max(-1.0, min(1.0, lon / 180.0))], dtype=np.float32)


def anchor_encoder(tmp_path: Path, lookup: dict[str, Any], mode: str) -> mailwoman_mtf.RowEncoder:
    return row_encoder(
        None, max_length=64, pad_id=0, anchor_lookup_path=write(tmp_path, "anchor", lookup), anchor_paint_mode=mode
    )


def char_pieces(raw: str) -> list[tuple[int, int]]:
    return [(i, i + 1) for i in range(len(raw))]


def painted_words(encoder: mailwoman_mtf.RowEncoder, raw: str, channel: str, bits: dict[str, int]) -> dict[str, int]:
    """Each word's painted bit set, read from the first alphanumeric character of the word."""
    features = encode(encoder, raw, char_pieces(raw))[f"{channel}_features"]
    slot_bits = list(bits.values())
    out: dict[str, int] = {}
    for m in re.finditer(r"\S+", raw):
        word = m.group().strip(",.")
        for c in range(m.start(), m.end()):
            if raw[c].isalnum():
                out[word] = sum(bit for bit, f in zip(slot_bits, features[c], strict=True) if f)
                break
    return out


# region The postcode anchor

STRASSE = "Strasse 12 10115 Berlin"
STRASSE_TOKENS = ["Strasse", "12", "10115", "Berlin"]
STRASSE_LABELS = ["B-street", "B-house_number", "B-postcode", "B-locality"]
DE_LOOKUP = {"10115": [{"DE": 1.0}, 52.53, 13.40]}


def test_the_gold_anchor_lands_on_exactly_the_postcode_pieces(tmp_path: Path) -> None:
    pieces = [(0, 7), (8, 10), (11, 14), (14, 16), (17, 23)]
    out = encode(
        anchor_encoder(tmp_path, DE_LOOKUP, "gold"), STRASSE, pieces, tokens=STRASSE_TOKENS, labels=STRASSE_LABELS
    )
    assert out["anchor_confidence"].tolist() == [0.0, 0.0, 1.0, 1.0, 0.0]
    de = anchor_vector({"DE": 1.0}, 52.53, 13.40)
    assert np.array_equal(out["anchor_features"][2], de) and np.array_equal(out["anchor_features"][3], de)
    assert not out["anchor_features"][[0, 1, 4]].any()


def test_an_unknown_postcode_yields_no_anchor(tmp_path: Path) -> None:
    out = encode(
        anchor_encoder(tmp_path, {}, "gold"),
        STRASSE,
        [(0, 7), (8, 10), (11, 16), (17, 23)],
        tokens=STRASSE_TOKENS,
        labels=STRASSE_LABELS,
    )
    assert not out["anchor_confidence"].any() and not out["anchor_features"].any()


def test_a_collision_posterior_is_renormalized_over_the_locale_set(tmp_path: Path) -> None:
    lookup = {"75001": [{"FR": 0.5, "US": 0.5, "XX": 1.0}, 48.86, 2.33]}
    raw = "1 rue de Rivoli 75001 Paris"
    out = encode(anchor_encoder(tmp_path, lookup, "shaped"), raw, [(0, 15), (16, 21), (22, 27)])
    vector = out["anchor_features"][1]
    assert len(vector) == ANCHOR_DIM
    assert vector[LOCALE_TO_ID["FR"]] == pytest.approx(0.5) and vector[LOCALE_TO_ID["US"]] == pytest.approx(0.5)
    assert sum(vector[:NUM_LOCALES]) == pytest.approx(1.0)
    assert vector[-2] == pytest.approx(48.86 / 90.0) and vector[-1] == pytest.approx(2.33 / 180.0)


HOUSE = "12345 Main St"
HOUSE_PIECES = [(0, 5), (6, 10), (11, 13)]
US_LOOKUP = {"12345": [{"US": 1.0}, 42.81, -73.93]}


def test_the_gold_path_paints_nothing_on_a_leading_house_number(tmp_path: Path) -> None:
    out = encode(
        anchor_encoder(tmp_path, US_LOOKUP, "gold"),
        HOUSE,
        HOUSE_PIECES,
        tokens=["12345", "Main", "St"],
        labels=["B-house_number", "B-street", "I-street"],
    )
    assert not out["anchor_confidence"].any()


def test_the_shaped_path_paints_a_leading_house_number_that_is_a_zip(tmp_path: Path) -> None:
    out = encode(anchor_encoder(tmp_path, US_LOOKUP, "shaped"), HOUSE, HOUSE_PIECES)
    assert out["anchor_confidence"].tolist() == [1.0, 0.0, 0.0]
    assert np.array_equal(out["anchor_features"][0], anchor_vector({"US": 1.0}, 42.81, -73.93))


def test_the_shaped_path_misses_a_shape_absent_from_the_lookup(tmp_path: Path) -> None:
    out = encode(anchor_encoder(tmp_path, {}, "shaped"), "99999 Main St", HOUSE_PIECES)
    assert not out["anchor_confidence"].any()


GB = "Buckingham Palace, London SW1A 2AA"
GB_PIECES = [(0, 10), (11, 17), (19, 25), (26, 30), (31, 34)]


def test_a_gb_unit_paints_from_its_space_stripped_key(tmp_path: Path) -> None:
    out = encode(anchor_encoder(tmp_path, {"SW1A2AA": [{"GB": 1.0}, 51.50354, -0.1277]}, "shaped"), GB, GB_PIECES)
    assert out["anchor_confidence"].tolist() == [0.0, 0.0, 0.0, 1.0, 1.0]
    gb = anchor_vector({"GB": 1.0}, 51.50354, -0.1277)
    assert np.array_equal(out["anchor_features"][3], gb) and np.array_equal(out["anchor_features"][4], gb)


def test_a_gb_unit_that_misses_paints_from_its_outward_district(tmp_path: Path) -> None:
    out = encode(anchor_encoder(tmp_path, {"SW1A": [{"GB": 1.0}, 51.50452, -0.13216]}, "shaped"), GB, GB_PIECES)
    assert out["anchor_confidence"].tolist() == [0.0, 0.0, 0.0, 1.0, 1.0]
    assert np.array_equal(out["anchor_features"][4], anchor_vector({"GB": 1.0}, 51.50452, -0.13216))


def test_the_unit_key_wins_over_the_outward_key(tmp_path: Path) -> None:
    lookup = {"SW1A2AA": [{"GB": 1.0}, 51.50354, -0.1277], "SW1A": [{"GB": 1.0}, 51.50452, -0.13216]}
    out = encode(anchor_encoder(tmp_path, lookup, "shaped"), GB, GB_PIECES)
    assert np.array_equal(out["anchor_features"][3], anchor_vector({"GB": 1.0}, 51.50354, -0.1277))


def test_the_outward_fallback_is_inert_for_a_five_digit_code(tmp_path: Path) -> None:
    out = encode(anchor_encoder(tmp_path, {"12": [{"US": 1.0}, 42.81, -73.93]}, "shaped"), HOUSE, HOUSE_PIECES)
    assert not out["anchor_confidence"].any()


def test_shaped_equals_gold_when_the_postcode_is_in_position(tmp_path: Path) -> None:
    pieces = [(0, 7), (8, 10), (11, 16), (17, 23)]
    row = {"tokens": STRASSE_TOKENS, "labels": STRASSE_LABELS}
    gold = encode(anchor_encoder(tmp_path, DE_LOOKUP, "gold"), STRASSE, pieces, **dict(row))
    shaped = encode(anchor_encoder(tmp_path, DE_LOOKUP, "shaped"), STRASSE, pieces, **dict(row))
    assert np.array_equal(gold["anchor_features"], shaped["anchor_features"])
    assert np.array_equal(gold["anchor_confidence"], shaped["anchor_confidence"])


# endregion

# region The gazetteer and country lexicons


@pytest.fixture
def gazetteer(tmp_path: Path) -> mailwoman_mtf.RowEncoder:
    return row_encoder(None, max_length=128, pad_id=0, gazetteer_lexicon_path=write(tmp_path, "gaz", GAZETTEER))


@pytest.fixture
def country(tmp_path: Path) -> mailwoman_mtf.RowEncoder:
    return row_encoder(None, max_length=128, pad_id=0, country_lexicon_path=write(tmp_path, "country", COUNTRY))


def gaz_words(encoder: mailwoman_mtf.RowEncoder, raw: str) -> dict[str, int]:
    return painted_words(encoder, raw, "gazetteer", GAZETTEER_BITS)


def country_words(encoder: mailwoman_mtf.RowEncoder, raw: str) -> dict[str, int]:
    return painted_words(encoder, raw, "country", COUNTRY["bits"])


def test_a_homograph_clue_is_the_same_in_either_country(gazetteer: mailwoman_mtf.RowEncoder) -> None:
    us = gaz_words(gazetteer, "291 Hill Road, Atlanta, Georgia 30601")
    foreign = gaz_words(gazetteer, "772 Main Street, Tbilisi, Georgia")
    assert us["Georgia"] == foreign["Georgia"] == 1 | 2 | 16
    assert us["Atlanta"] == 0 and us["30601"] == 0


def test_short_codes_match_uppercase_only(gazetteer: mailwoman_mtf.RowEncoder) -> None:
    assert gaz_words(gazetteer, "Los Angeles, CA 90012")["CA"] == 1 | 2 | 16
    assert gaz_words(gazetteer, "turn left in paris")["in"] == 0
    assert gaz_words(gazetteer, "the ca registry")["ca"] == 0
    assert gaz_words(gazetteer, "Indianapolis, IN 46204")["IN"] == 1 | 2 | 16


def test_a_multiword_entry_paints_every_word(gazetteer: mailwoman_mtf.RowEncoder) -> None:
    words = gaz_words(gazetteer, "San Jose, Costa Rica")
    assert words["Costa"] == words["Rica"] == 1
    words = gaz_words(gazetteer, "New York, NY 10001, United States")
    assert words["United"] == words["States"] == 1


def test_punctuation_is_stripped_for_matching(gazetteer: mailwoman_mtf.RowEncoder) -> None:
    assert gaz_words(gazetteer, "Tbilisi, Georgia, hello")["Georgia"] == 1 | 2 | 16
    assert gaz_words(gazetteer, "Dili, Timor-Leste")["Timor-Leste"] == 1


def test_po_box_and_cedex_clues(gazetteer: mailwoman_mtf.RowEncoder) -> None:
    words = gaz_words(gazetteer, "PO Box 1234, Springfield")
    assert words["PO"] == words["Box"] == 4
    assert gaz_words(gazetteer, "12 Box Canyon Rd")["Box"] == 4
    assert gaz_words(gazetteer, "75008 PARIS CEDEX 02")["CEDEX"] == 8


def test_a_piece_takes_its_first_non_space_character(gazetteer: mailwoman_mtf.RowEncoder) -> None:
    out = encode(gazetteer, "Tbilisi, Georgia", [(0, 7), (7, 9), (9, 12), (12, 16)])
    assert not out["gazetteer_features"][:2].any() and out["gazetteer_confidence"][:2].tolist() == [0.0, 0.0]
    for i in (2, 3):
        assert out["gazetteer_features"][i].tolist() == [1.0, 1.0, 0.0, 0.0, 1.0]
        assert out["gazetteer_confidence"][i] == 1.0


def test_choreography_zeros_the_clue_beside_a_postcode_anchor(tmp_path: Path) -> None:
    raw = "x Georgia 10115"
    pieces = [(0, 1), (2, 9), (10, 15)]
    lexicon = write(tmp_path, "gaz", GAZETTEER)
    anchor = write(tmp_path, "anchor", DE_LOOKUP)

    def gazetteer_confidence(choreography: bool, text: str = raw, spans: list[tuple[int, int]] = pieces) -> list[float]:
        enc = row_encoder(
            None,
            max_length=8,
            pad_id=0,
            anchor_lookup_path=anchor,
            anchor_paint_mode="shaped",
            gazetteer_lexicon_path=lexicon,
            gazetteer_choreography=choreography,
        )
        return encode(enc, text, spans)["gazetteer_confidence"].tolist()

    assert gazetteer_confidence(False) == [0.0, 1.0, 0.0]
    assert gazetteer_confidence(True) == [0.0, 0.0, 0.0]
    # Two pieces from the anchor, outside the one-piece window, the clue stays.
    assert gazetteer_confidence(True, "Georgia x 10115", [(0, 7), (8, 9), (10, 15)]) == [1.0, 0.0, 0.0]


def test_a_long_leading_country_form_paints_every_word_unambiguous(country: mailwoman_mtf.RowEncoder) -> None:
    w = country_words(country, "United States of America, Wyoming, Cheyenne")
    assert w["United"] == w["States"] == w["of"] == w["America"] == S
    assert w["Wyoming"] == w["Cheyenne"] == 0


def test_a_standalone_homograph_country_is_ambiguous(country: mailwoman_mtf.RowEncoder) -> None:
    assert country_words(country, "123 America Avenue")["America"] == S | A
    assert country_words(country, "291 Hill Road, Atlanta, Georgia 30601")["Georgia"] == S | A
    assert country_words(country, "772 Main Street, Tbilisi, Georgia")["Georgia"] == S | A


def test_country_codes_match_uppercase_only(country: mailwoman_mtf.RowEncoder) -> None:
    assert country_words(country, "New York, NY 10001, USA")["USA"] == S
    assert country_words(country, "meet us there")["us"] == 0
    assert country_words(country, "Toronto, ON, CA")["CA"] == S | A
    assert country_words(country, "Paris, FR")["FR"] == S


def test_the_country_channel_emits_surface_and_ambiguity_with_surface_confidence(
    country: mailwoman_mtf.RowEncoder,
) -> None:
    out = encode(country, "Tbilisi, Georgia", [(0, 7), (7, 9), (9, 12), (12, 16)])
    assert out["country_features"].tolist() == [[0.0, 0.0], [0.0, 0.0], [1.0, 1.0], [1.0, 1.0]]
    assert out["country_confidence"].tolist() == [0.0, 0.0, 1.0, 1.0]
    out = encode(country, "United States of America", [(0, 6), (6, 13), (13, 16), (16, 24)])
    assert out["country_features"].tolist() == [[1.0, 0.0]] * 4
    assert out["country_confidence"].tolist() == [1.0] * 4


# endregion
