"""SentencePiece tokenization with character offsets, through the `mailwoman_mtf` extension.

The corpus parquet stores ``raw`` plus a whitespace-tokenized ``tokens`` list and a parallel ``labels`` list
(BIO over those whitespace tokens). As of the v0.5.0 char-offset migration (#519) rows additionally store
``span_starts[]``/``span_ends[]``/``span_tags[]``, char ranges over ``raw``. The neural model trains over
SentencePiece pieces, which are finer-grained than the whitespace tokens.

`Tokenizer` loads a model with `mtf-core`, which reproduces SentencePiece 0.2.2's ids and UTF-8 offsets, and
reports each piece's code-point range. The training encoder in `packages/mtf/crates/mtf-channels` projects labels
and channels onto those pieces. `spans` holds the Python projection the char path and the tokenizer check use;
`char` implements the character path without SentencePiece. Training, splicing and pruning a model are the
TypeScript tools under `packages/mtf/tools/tokenizer/`.
"""

from __future__ import annotations

from pathlib import Path

import mailwoman_mtf

from ..types import PieceSpan
from .spans import (
    char_label_array,
    char_label_array_from_spans,
    project_char_labels_to_pieces,
    realign_labels_to_pieces,
    realign_spans_to_pieces,
    whitespace_spans,
)

__all__ = [
    "PieceSpan",
    "Tokenizer",
    "char_label_array",
    "char_label_array_from_spans",
    "project_char_labels_to_pieces",
    "realign_labels_to_pieces",
    "realign_spans_to_pieces",
    "whitespace_spans",
]


class Tokenizer:
    """A SentencePiece model loaded by `mtf-core`, with each piece's character range."""

    def __init__(self, model_path: Path | str) -> None:
        self.model_path = Path(model_path)
        #: The extension's tokenizer, which `data.loader.encode.row_encoder` hands to the row encoder.
        self.mtf = mailwoman_mtf.Tokenizer(self.model_path.read_bytes())

    @property
    def vocab_size(self) -> int:
        return self.mtf.vocab_size

    @property
    def pad_id(self) -> int:
        return self.mtf.pad_id

    @property
    def unk_id(self) -> int:
        return self.mtf.unk_id

    @property
    def bos_id(self) -> int:
        return self.mtf.bos_id

    @property
    def eos_id(self) -> int:
        return self.mtf.eos_id

    def id_to_piece(self, piece_id: int) -> str:
        """The text of piece `piece_id`."""
        return self.mtf.id_to_piece(piece_id)

    def encode_with_spans(self, raw: str) -> list[PieceSpan]:
        """Encode raw text and return one ``PieceSpan`` per piece, with code-point offsets.

        A piece that begins with the `▁` word marker covers the space before its word.
        """
        return [
            PieceSpan(piece=piece, piece_id=piece_id, char_begin=begin, char_end=end)
            for piece_id, piece, begin, end in self.mtf.encode(raw)
        ]
