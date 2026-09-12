"""Script-agnostic surface normalization for CJK field values.

`normalize_text` is the join key the KEN_ALL probe and the TW builder both use. It arrived here as
two names — `norm_key` in the JP builder and `normalize_text` in the TW one — whose bodies differed
only by a trailing `.replace("　", "")` that removed nothing: `str.split()` already treats U+3000 as
whitespace, so both spellings answered identically on every input.
"""

from __future__ import annotations

import unicodedata

_FULLWIDTH_DIGITS = str.maketrans("０１２３４５６７８９", "0123456789")
_ASCII_TO_FULLWIDTH = str.maketrans("0123456789", "０１２３４５６７８９")


def normalize_text(text: str) -> str:
    """NFC with every whitespace removed, interior included.

    No CJK address component carries an interior space. 135 JP street values hold an ideographic
    space (``西与賀町　字今津乙``) as a rendering artifact of the source; the written form closes it
    up, and leaving it in put a U+3000 inside a ``district`` span.
    """
    return "".join(unicodedata.normalize("NFC", text).split())


def ascii_digits(text: str) -> str:
    """Fold full-width numerals to ASCII, leaving every other character alone."""
    return text.translate(_FULLWIDTH_DIGITS)


def fullwidth_digits(text: str) -> str:
    """The inverse of `ascii_digits` — the register a TW source renders numerals in."""
    return text.translate(_ASCII_TO_FULLWIDTH)
