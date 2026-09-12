"""Shared value types.

These live apart from the modules that produce them so a consumer can name a type without importing
the machinery that builds it. `PieceSpan` sat in `tokenizer.py`, which made `tokenizer` and the
alignment modules import each other and forced five function-body imports to dodge the cycle.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PieceSpan:
    """One SentencePiece piece with its offsets into the original `raw` string."""

    piece: str
    piece_id: int
    # Character offsets into the original ``raw`` string (inclusive begin, exclusive end).
    char_begin: int
    char_end: int
