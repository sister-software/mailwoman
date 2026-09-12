"""SentencePiece tokenization with byte-exact character offsets.

The corpus parquet stores ``raw`` plus a whitespace-tokenized ``tokens`` list and a parallel
``labels`` list (BIO over those whitespace tokens). As of the v0.5.0 char-offset migration
(#519) rows additionally carry ``span_starts[]``/``span_ends[]``/``span_tags[]`` — char ranges
over ``raw`` (sorted, non-overlapping) — which become the label source of truth. The neural model
is trained over SentencePiece sub-tokens, which are *finer-grained* than the whitespace tokens.

The byte-offset hook is ``EncodeAsImmutableProto`` — the only SentencePiece API that exposes
``piece.begin`` / ``piece.end`` (in bytes). We convert those to char offsets via a precomputed
byte→char index map so multibyte UTF-8 (accents, CJK) round-trips correctly.

Why not a HuggingFace fast tokenizer? Two reasons:

- We don't have a ``tokenizer.json`` for this SP model — only ``tokenizer.model``. Converting
  is doable (PreTrainedTokenizerFast supports loading SP via slow→fast bridge) but adds a
  fragile build step. Going direct is simpler and the offsets are exact.
- We need labels aligned at *training-data prep* time, not inference time. The training loop
  consumes pre-aligned ``(input_ids, label_ids)`` tensors, so we don't need a HF tokenizer
  object at all once labels are baked.

The rest of the package: `spans` projects a row's labels onto pieces, `anchors` projects the
postcode-anchor channel, `encode` assembles a row's tensors, `char` is the character-path encoder
that skips SentencePiece entirely, and `splice`/`train` build and surgically edit a model.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast

import sentencepiece as spm

from ..types import PieceSpan
from .anchors import (
    ANCHOR_FEATURE_DIM,
    anchor_feature_vector,
    realign_anchor_to_pieces,
    realign_anchor_to_pieces_from_spans,
    realign_anchor_to_pieces_shaped,
)
from .encode import encode_row
from .spans import (
    char_label_array,
    char_label_array_from_spans,
    project_char_labels_to_pieces,
    realign_labels_to_pieces,
    realign_spans_to_pieces,
    whitespace_spans,
)

__all__ = [
    "ANCHOR_FEATURE_DIM",
    "PieceSpan",
    "Tokenizer",
    "anchor_feature_vector",
    "char_label_array",
    "char_label_array_from_spans",
    "encode_row",
    "project_char_labels_to_pieces",
    "realign_anchor_to_pieces",
    "realign_anchor_to_pieces_from_spans",
    "realign_anchor_to_pieces_shaped",
    "realign_labels_to_pieces",
    "realign_spans_to_pieces",
    "whitespace_spans",
]


class Tokenizer:
    """SentencePiece tokenizer + sub-token char-span realignment helpers."""

    def __init__(self, model_path: Path | str) -> None:
        self.model_path = Path(model_path)
        self.sp = spm.SentencePieceProcessor(model_file=str(self.model_path))

    @property
    def vocab_size(self) -> int:
        return int(self.sp.get_piece_size())

    @property
    def pad_id(self) -> int:
        return int(self.sp.pad_id())

    @property
    def unk_id(self) -> int:
        return int(self.sp.unk_id())

    @property
    def bos_id(self) -> int:
        return int(self.sp.bos_id())

    @property
    def eos_id(self) -> int:
        return int(self.sp.eos_id())

    def encode_with_spans(self, raw: str) -> list[PieceSpan]:
        """Encode raw text and return one ``PieceSpan`` per sub-token with char offsets."""
        try:
            proto = self.sp.encode(raw, out_type=cast(Any, "immutable_proto"))
        except ValueError:
            # sentencepiece ≥0.2.2 renamed the proto out_type (Modal's pinned image keeps the old
            # spelling; local dev venvs track newer). Identical pieces/offsets either way.
            proto = self.sp.encode(raw, out_type=cast(Any, "proto"))
        # Build a byte→char index for the original raw string so we can map proto byte offsets.
        raw_bytes = raw.encode("utf-8")
        # ``byte_to_char[i]`` is the char index of the codepoint that owns byte ``i`` (start byte).
        byte_to_char = [0] * (len(raw_bytes) + 1)
        ci = 0
        bi = 0
        for ch in raw:
            ch_bytes = ch.encode("utf-8")
            for offset in range(len(ch_bytes)):
                byte_to_char[bi + offset] = ci
            bi += len(ch_bytes)
            ci += 1
        byte_to_char[bi] = ci

        out: list[PieceSpan] = []
        for piece in proto.pieces:
            begin = byte_to_char[piece.begin]
            end = byte_to_char[piece.end] if piece.end <= len(raw_bytes) else len(raw)
            out.append(
                PieceSpan(
                    piece=piece.piece,
                    piece_id=piece.id,
                    char_begin=begin,
                    char_end=end,
                )
            )
        return out
