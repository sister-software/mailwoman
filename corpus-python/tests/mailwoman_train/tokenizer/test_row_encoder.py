"""`mailwoman_mtf.RowEncoder.encode_batch`: the arrays' layout and ownership, the width rules, and invalid rows.

The arrays are what `to_tensor_batch` wraps for the model, so their dtype, shape and contiguity are the tensor
interface, and `torch.from_numpy` must share their memory rather than copy it. The value parity with the Python
encoder the extension replaced is checked by `audits/encoder_parity.py` over sampled corpus rows and by the
crate's fixture tests. These tests run on a small model trained here, so they need no model file.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import mailwoman_mtf
import numpy as np
import pytest
import torch

from mailwoman_train.labels import ACTIVE_TAGS, IGNORE_INDEX, LABEL_TO_ID, LOCALE_COUNTRIES
from mailwoman_train.paths import package_path

from .test_mailwoman_mtf import train_small_model

ROW = {
    "raw": "10 Downing St, London SW1A 2AA",
    "tokens": ["10", "Downing", "St,", "London", "SW1A", "2AA"],
    "labels": ["B-house_number", "B-street", "I-street", "B-locality", "B-postcode", "I-postcode"],
    "span_starts": [0, 3, 15, 22],
    "span_ends": [2, 13, 21, 30],
    "span_tags": ["house_number", "street", "locality", "postcode"],
}


def lexicon(slots: list[str], entries: dict[str, int]) -> dict[str, Any]:
    return {
        "feature_dim": len(slots),
        "slots": slots,
        "bits": {slot: 1 << i for i, slot in enumerate(slots)},
        "max_ngram": 2,
        "entries": entries,
        "code_entries": {},
    }


@pytest.fixture(scope="module")
def tokenizer() -> mailwoman_mtf.Tokenizer:
    return mailwoman_mtf.Tokenizer(train_small_model())


@pytest.fixture(scope="module")
def lexicon_paths(tmp_path_factory: pytest.TempPathFactory) -> dict[str, str]:
    root = tmp_path_factory.mktemp("lexicons")
    documents = {
        "anchor_lookup_path": {"SW1A": [{"GB": 1.0}, 51.50452, -0.13216, "wof"]},
        # "downing" sits two words from the postcode, outside the near-postcode suppression window.
        "gazetteer_lexicon_path": lexicon(["locality", "country"], {"downing": 1}),
        "country_lexicon_path": lexicon(["country_surface", "country_ambiguous"], {"downing": 3}),
        "street_type_lexicon_path": lexicon(["street_type"], {"st": 1}),
        "locality_surface_lexicon_path": lexicon(["locality", "locality_homograph"], {"london": 1}),
    }
    paths: dict[str, str] = {}
    for key, document in documents.items():
        path = root / f"{key}.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        paths[key] = str(path)
    return paths


def encoder(
    tokenizer: mailwoman_mtf.Tokenizer | None, max_length: int = 32, **overrides: Any
) -> mailwoman_mtf.RowEncoder:
    kwargs: dict[str, Any] = {
        "max_length": max_length,
        "label_to_id": dict(LABEL_TO_ID),
        "active_tags": list(ACTIVE_TAGS),
        "ignore_index": IGNORE_INDEX,
        "locale_countries": list(LOCALE_COUNTRIES),
        "postcode_shapes_path": str(package_path("features", "postcode-shapes.json")),
        "postcode_syntax_path": str(package_path("data", "postcode-syntax.json")),
    }
    kwargs.update(overrides)
    return mailwoman_mtf.RowEncoder(tokenizer, **kwargs)


def all_channels(
    tokenizer: mailwoman_mtf.Tokenizer, paths: dict[str, str], max_length: int = 32
) -> mailwoman_mtf.RowEncoder:
    return encoder(
        tokenizer,
        max_length,
        **paths,
        anchor_paint_mode="shaped",
        gazetteer_choreography=True,
        code_units=True,
    )


def test_every_array_is_contiguous_owned_and_shaped_for_the_batch(
    tokenizer: mailwoman_mtf.Tokenizer, lexicon_paths: dict[str, str]
) -> None:
    enc = all_channels(tokenizer, lexicon_paths)
    batch = enc.encode_batch([ROW, ROW, ROW])
    dims = dict(enc.channel_dims)
    assert [name for name, _ in enc.channel_dims] == list(mailwoman_mtf.CHANNEL_NAMES)
    for name in ("input_ids", "attention_mask", "labels"):
        assert batch[name].dtype == np.int64 and batch[name].shape == (3, 32)
    for channel, dim in dims.items():
        assert batch[f"{channel}_features"].dtype == np.float32
        assert batch[f"{channel}_features"].shape == (3, 32, dim)
        assert batch[f"{channel}_confidence"].shape == (3, 32)
    for name, array in batch.items():
        assert array.flags.c_contiguous, name


def test_torch_shares_the_arrays_memory_and_it_outlives_later_batches(
    tokenizer: mailwoman_mtf.Tokenizer, lexicon_paths: dict[str, str]
) -> None:
    enc = all_channels(tokenizer, lexicon_paths)
    first = enc.encode_batch([ROW])
    tensors = {name: torch.from_numpy(array) for name, array in first.items()}
    snapshot = {name: array.copy() for name, array in first.items()}
    for name, array in first.items():
        assert tensors[name].data_ptr() == array.ctypes.data, name
        assert tensors[name].is_contiguous(), name
    for _ in range(5):
        enc.encode_batch(
            [
                {
                    **ROW,
                    "raw": "1 rue de Rivoli, 75001 Paris",
                    "span_starts": None,
                    "span_ends": None,
                    "span_tags": None,
                    "tokens": ["1", "rue", "de", "Rivoli,", "75001", "Paris"],
                    "labels": ["O"] * 6,
                }
            ]
        )
    for name, tensor in tensors.items():
        assert np.array_equal(tensor.numpy(), snapshot[name]), name


def test_padding_carries_pad_ids_ignored_labels_and_zero_channels(
    tokenizer: mailwoman_mtf.Tokenizer, lexicon_paths: dict[str, str]
) -> None:
    enc = all_channels(tokenizer, lexicon_paths)
    batch = enc.encode_batch([ROW])
    pieces = len(tokenizer.encode(ROW["raw"]))
    assert int(batch["attention_mask"].sum()) == pieces
    assert (batch["input_ids"][0, pieces:] == tokenizer.pad_id).all()
    assert (batch["labels"][0, pieces:] == IGNORE_INDEX).all()
    for channel, _ in enc.channel_dims:
        assert not batch[f"{channel}_features"][0, pieces:].any(), channel
        assert not batch[f"{channel}_confidence"][0, pieces:].any(), channel
    # The fixture paints every channel, so a channel that stops painting shows here.
    for channel, _ in enc.channel_dims:
        assert batch[f"{channel}_confidence"][0].any(), f"{channel} painted nothing"


def test_a_row_of_exactly_max_length_pieces_has_no_padding(tokenizer: mailwoman_mtf.Tokenizer) -> None:
    pieces = len(tokenizer.encode(ROW["raw"]))
    batch = encoder(tokenizer, pieces).encode_batch([ROW])
    assert batch["attention_mask"].shape == (1, pieces)
    assert batch["attention_mask"].all()


def test_a_row_longer_than_max_length_truncates_every_array(
    tokenizer: mailwoman_mtf.Tokenizer, lexicon_paths: dict[str, str]
) -> None:
    words = [f"w{i}" for i in range(200)]
    row = {"raw": " ".join(words), "tokens": words, "labels": ["O"] * len(words)}
    assert len(tokenizer.encode(row["raw"])) > 200
    enc = all_channels(tokenizer, lexicon_paths, max_length=16)
    batch = enc.encode_batch([row])
    assert batch["attention_mask"].shape == (1, 16) and batch["attention_mask"].all()
    for channel, dim in enc.channel_dims:
        assert batch[f"{channel}_features"].shape == (1, 16, dim)


def test_a_channel_free_encoder_emits_only_ids_mask_and_labels(tokenizer: mailwoman_mtf.Tokenizer) -> None:
    enc = encoder(tokenizer)
    assert enc.channel_dims == []
    assert set(enc.encode_batch([ROW])) == {"input_ids", "attention_mask", "labels"}


def test_given_pieces_replace_the_tokenizer(tokenizer: mailwoman_mtf.Tokenizer) -> None:
    pieces = [(piece_id, begin, end) for piece_id, _, begin, end in tokenizer.encode(ROW["raw"])]
    with_tokenizer = encoder(tokenizer).encode_batch([ROW])
    without = encoder(None, pad_id=tokenizer.pad_id).encode_batch([ROW], pieces=[pieces])
    for name in with_tokenizer:
        assert np.array_equal(with_tokenizer[name], without[name]), name
    with pytest.raises(ValueError, match="needs pieces"):
        encoder(None, pad_id=0).encode_batch([ROW])


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"span_tags": None}, "must be supplied together"),
        ({"span_ends": [2, 13, 21]}, "length mismatch"),
        ({"span_starts": [3, 0, 15, 22], "span_ends": [13, 2, 21, 30]}, "not sorted"),
        ({"span_starts": [0, 1, 15, 22]}, "overlap"),
        ({"span_ends": [2, 13, 21, 31]}, "out of bounds"),
        ({"span_starts": None, "span_ends": None, "span_tags": None, "labels": ["O"]}, "length mismatch"),
        (
            {
                "span_starts": None,
                "span_ends": None,
                "span_tags": None,
                "tokens": ["10", "Nowhere", "St,", "London", "SW1A", "2AA"],
            },
            "not found",
        ),
    ],
)
def test_an_invalid_row_raises_naming_its_index_and_text(
    tokenizer: mailwoman_mtf.Tokenizer, change: dict[str, Any], message: str
) -> None:
    with pytest.raises(ValueError, match=message) as raised:
        encoder(tokenizer).encode_batch([ROW, {**ROW, **change}])
    assert "row 1" in str(raised.value)
    assert "Downing" in str(raised.value)


def test_an_unknown_anchor_mode_and_a_missing_lexicon_raise(tokenizer: mailwoman_mtf.Tokenizer, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="anchor_paint_mode"):
        encoder(tokenizer, anchor_paint_mode="golden")
    with pytest.raises(ValueError, match="cannot read"):
        encoder(tokenizer, gazetteer_lexicon_path=str(tmp_path / "absent.json"))
