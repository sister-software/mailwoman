"""Japanese kana and kanji-numeral handling.

Shared by the JP, TW, KR and CJK builders and by the register readers, none of which should reach
a sibling builder for it.
"""

from __future__ import annotations

import unicodedata

_KANJI_DIGITS = {"〇": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
_ARABIC_DIGITS = "〇一二三四五六七八九"


def fold_halfwidth_kana(text: str) -> str:
    """Fold half-width katakana (U+FF61–FF9F) to full width, composing the dakuten.

    Targeted, not blanket NFKC: NFKC would also fold full-width digits to ASCII, and the two-register
    chōme convention needs those registers kept apart. The fold is LENGTH-CHANGING (ﾃﾞ → デ, 2 chars
    → 1), which is safe here only because it runs on field values BEFORE they are concatenated and
    their spans recorded. 14,739 ``number`` values in the source need it.
    """
    if not any(0xFF61 <= ord(c) <= 0xFF9F for c in text):
        return text
    folded = "".join(unicodedata.normalize("NFKC", c) if 0xFF61 <= ord(c) <= 0xFF9F else c for c in text)
    return unicodedata.normalize("NFC", folded)


def kanji_to_int(text: str) -> int | None:
    """Parse a JP numeral (either register) to an int. Returns None if it is not one.

    Handles the forms a chōme actually takes: bare digits (ASCII or full-width), the digit-string
    kanji register (〇一二…), and the positional kanji register up to 百 (一丁目 … 二十三丁目).
    """
    if not text:
        return None
    ascii_form = unicodedata.normalize("NFKC", text)
    if ascii_form.isdigit():
        return int(ascii_form)
    if all(c in _KANJI_DIGITS for c in text):
        return int("".join(str(_KANJI_DIGITS[c]) for c in text))
    total = 0
    current = 0
    for char in text:
        if char == "十":
            current = (current or 1) * 10
            total += current
            current = 0
        elif char == "百":
            current = (current or 1) * 100
            total += current
            current = 0
        elif char in _KANJI_DIGITS:
            current = _KANJI_DIGITS[char]
        else:
            return None
    return total + current


def int_to_kanji(value: int) -> str:
    """Render an int in the positional kanji register (the register the source's 丁目 uses)."""
    if value < 0:
        raise ValueError(f"negative chōme: {value}")
    if value < 10:
        return _ARABIC_DIGITS[value]
    if value < 100:
        tens, ones = divmod(value, 10)
        return ("" if tens == 1 else _ARABIC_DIGITS[tens]) + "十" + (_ARABIC_DIGITS[ones] if ones else "")
    hundreds, rest = divmod(value, 100)
    head = ("" if hundreds == 1 else _ARABIC_DIGITS[hundreds]) + "百"
    return head + (int_to_kanji(rest) if rest else "")
