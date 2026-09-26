"""Script-agnostic surface normalization for CJK field values.

`normalize_text` is the join key the KEN_ALL probe and the TW builder both use.
"""

from __future__ import annotations

import unicodedata

_FULLWIDTH_DIGITS = str.maketrans("０１２３４５６７８９", "0123456789")
_ASCII_TO_FULLWIDTH = str.maketrans("0123456789", "０１２３４５６７８９")


def normalize_text(text: str) -> str:
    """NFC with every whitespace removed, interior included — no CJK address component carries an
    interior space."""
    return "".join(unicodedata.normalize("NFC", text).split())


def ascii_digits(text: str) -> str:
    """Fold full-width numerals to ASCII, leaving every other character alone."""
    return text.translate(_FULLWIDTH_DIGITS)


def fullwidth_digits(text: str) -> str:
    """The inverse of `ascii_digits` — the register a TW source renders numerals in."""
    return text.translate(_ASCII_TO_FULLWIDTH)
