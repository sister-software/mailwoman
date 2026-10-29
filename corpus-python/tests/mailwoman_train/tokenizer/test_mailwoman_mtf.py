"""`mailwoman_mtf.Tokenizer` reproduces SentencePiece 0.2.2's pieces, ids, special ids and piece lookup.

The training loader tokenizes through the extension, so its pieces and their character ranges decide every label
and channel position. Each test compares the extension with the `sentencepiece` package on the same model. A small
unigram model is trained here, so the comparison runs on a host without the shipped models. The C6 vocabulary the
current base trains on is compared too when the data root holds it.
"""

from __future__ import annotations

import io
import json
from collections.abc import Iterator
from typing import Any, cast

import mailwoman_mtf
import pytest
import sentencepiece as spm

from mailwoman_train.env import MissingEnvironmentError
from mailwoman_train.paths import data_root_path, repo_root_path

#: Training text for the small model: Latin, Cyrillic and CJK addresses, digits and punctuation.
CORPUS = [
    "350 5th Ave, New York, NY 10118-0110",
    "10 Downing St, London SW1A 2AA",
    "Strasse 12, 10115 Berlin",
    "1 rue de Rivoli, 75001 Paris",
    "Calle Mayor 5, 28013 Madrid",
    "ул. Тверская, 7, Москва, 125009",
    "東京都千代田区丸の内1-9-1",
    "Apt 4B-12, 221B Baker St",
    "PO Box 1234, Springfield, IL 62704",
    "Rua Ramiro Barcelos, Porto Alegre 95090-020",
] * 20

#: Inputs the comparison encodes, including the cases where byte and character offsets part.
INPUTS = [
    *CORPUS[:10],
    "",
    " ",
    "  leading and trailing  ",
    "tab\tand\nnewline",
    "non breaking",
    "é combining",
    "𦑃 astral 1",
    "emoji 🏠 house",
    "١٢٣ Arabic-Indic digits",
    "ＦＵＬＬ　ＷＩＤＴＨ",
    "unseen ქართული",
]


def train_small_model() -> bytes:
    """A unigram model of at most 400 pieces, with byte fallback and split digits, trained on `CORPUS`."""
    model = io.BytesIO()
    spm.SentencePieceTrainer.train(
        sentence_iterator=iter(CORPUS),
        model_writer=model,
        vocab_size=400,
        hard_vocab_limit=False,
        model_type="unigram",
        split_digits=True,
        byte_fallback=True,
        character_coverage=1.0,
        user_defined_symbols=[",", "-"],
        num_threads=1,
        minloglevel=2,
    )
    return model.getvalue()


@pytest.fixture(scope="module")
def small_model() -> bytes:
    return train_small_model()


def sentencepiece_pieces(sp: spm.SentencePieceProcessor, raw: str) -> list[tuple[int, str, int, int]]:
    """SentencePiece's pieces with UTF-8 offsets mapped to code points, as the Python loader mapped them."""
    proto = sp.encode(raw, out_type=cast(Any, "proto"))
    byte_to_char: list[int] = []
    for index, char in enumerate(raw):
        byte_to_char.extend([index] * len(char.encode("utf-8")))
    byte_to_char.append(len(raw))
    size = len(raw.encode("utf-8"))
    return [
        (p.id, p.piece, byte_to_char[p.begin], byte_to_char[p.end] if p.end <= size else len(raw)) for p in proto.pieces
    ]


def compare(model: bytes, inputs: Iterator[str] | list[str]) -> int:
    sp = spm.SentencePieceProcessor(model_proto=model)
    tokenizer = mailwoman_mtf.Tokenizer(model)
    compared = 0
    for raw in inputs:
        assert tokenizer.encode(raw) == sentencepiece_pieces(sp, raw), raw
        compared += 1
    return compared


def test_pieces_and_ranges_match_sentencepiece_on_the_small_model(small_model: bytes) -> None:
    assert compare(small_model, INPUTS) == len(INPUTS)


def test_special_ids_and_vocabulary_match(small_model: bytes) -> None:
    sp = spm.SentencePieceProcessor(model_proto=small_model)
    tokenizer = mailwoman_mtf.Tokenizer(small_model)
    assert tokenizer.vocab_size == sp.get_piece_size()
    assert (tokenizer.pad_id, tokenizer.unk_id, tokenizer.bos_id, tokenizer.eos_id) == (
        sp.pad_id(),
        sp.unk_id(),
        sp.bos_id(),
        sp.eos_id(),
    )
    for piece_id in range(sp.get_piece_size()):
        piece = sp.id_to_piece(piece_id)
        assert tokenizer.id_to_piece(piece_id) == piece
        assert tokenizer.piece_to_id(piece) == sp.piece_to_id(piece)
    assert tokenizer.piece_to_id("no such piece") == sp.piece_to_id("no such piece")
    with pytest.raises(IndexError):
        tokenizer.id_to_piece(sp.get_piece_size())


def test_a_model_without_a_pad_piece_reports_minus_one() -> None:
    """SentencePiece reports -1 for a special piece the model lacks, and the extension must too."""
    model = io.BytesIO()
    spm.SentencePieceTrainer.train(
        sentence_iterator=iter(CORPUS),
        model_writer=model,
        vocab_size=250,
        hard_vocab_limit=False,
        model_type="unigram",
        pad_id=-1,
        bos_id=-1,
        num_threads=1,
        minloglevel=2,
    )
    sp = spm.SentencePieceProcessor(model_proto=model.getvalue())
    tokenizer = mailwoman_mtf.Tokenizer(model.getvalue())
    assert (tokenizer.pad_id, tokenizer.bos_id, tokenizer.eos_id) == (sp.pad_id(), sp.bos_id(), sp.eos_id())
    assert tokenizer.pad_id == -1


def test_a_malformed_model_raises() -> None:
    with pytest.raises(ValueError):
        mailwoman_mtf.Tokenizer(b"not a model")


try:
    C6_MODEL = data_root_path("models", "tokenizer", "v0.10.0-c6-isolated-punctuation", "tokenizer.model")
    _C6_SKIP = None if C6_MODEL.exists() else f"the C6 tokenizer model is absent at {C6_MODEL}"
except MissingEnvironmentError:
    _C6_SKIP = "MAILWOMAN_DATA_ROOT is unset, so the C6 tokenizer model cannot be located"


@pytest.mark.skipif(_C6_SKIP is not None, reason=_C6_SKIP or "")
def test_pieces_and_ranges_match_sentencepiece_on_the_c6_model() -> None:
    board = json.loads(repo_root_path("packages", "mtf", "test", "fixtures", "board-reference-v0.2.2.json").read_text())
    raws = [row["text"] for row in board["rows"]]
    assert compare(C6_MODEL.read_bytes(), [*raws, *INPUTS]) == len(raws) + len(INPUTS)
