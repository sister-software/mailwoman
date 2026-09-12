"""Japanese address text: the prefecture set, the field normalizers, the chōme split.

These are read by both of Japan's other modules — the corpus builder renders with them, the
register reader matches with them — so neither can own them. While they lived in the builder, the
register reader imported a corpus builder to normalize a name.

Script-level work that is not specific to Japan lives in `text/`: `text.kana` folds half-width kana
and converts kanji numerals, `text.normalize` handles the shared cases.
"""

from __future__ import annotations

import re
import unicodedata

from ...text.kana import fold_halfwidth_kana, kanji_to_int

#: The canonical 47. Overture's `address_levels[0]` carries occasional junk (`東京都1`); a full pass
#: counted 48 distinct values, so exactly one junk variant survives into 19.6M rows.
JP_PREFECTURES = frozenset(
    "北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 "
    "新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 "
    "奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 "
    "熊本県 大分県 宮崎県 鹿児島県 沖縄県".split()
)

# Hyphen-equivalence class. Applied to the NUMBER field only: U+30FC and U+FF70 are prolonged-sound
# marks that belong inside katakana names, and folding them there would corrupt the name. In a
# banchi-go they are a typed hyphen.
_HYPHEN_CLASS = "‐‑‒–—―−ー﹘﹣－ｰ"
_HYPHEN_TABLE = str.maketrans({character: "-" for character in _HYPHEN_CLASS})

#: The variant hyphens a real keyboard or IME emits, for the robustness fraction. U+30FC is the one
#: a Japanese IME produces when the user hits the key next to 0 in kana mode.
VARIANT_HYPHENS = ("ー", "−", "－")

_CHOME_TAIL = re.compile(r"^(.*?)([0-9０-９〇一二三四五六七八九十百]+)丁目$")


def normalize_name(text: str) -> str:
    """Normalize a NAME field (prefecture / municipality / street): NFC + kana fold + de-space.

    ALL whitespace is removed, interior included. 135 street values carry an ideographic space
    (``西与賀町　字今津乙``) which is a rendering artifact of the source, not part of the name — the
    written form closes it up, and leaving it in put a U+3000 inside a ``district`` span (found by
    counting labelled chars against significant chars on the first full build: coverage read
    1.000001, which is how a six-row defect announces itself).

    Explicitly does not touch hyphens (U+30FC is a real katakana character here) and does not fold
    itaiji — the MJ縮退マップ tables are CC BY-SA.
    """
    return "".join(fold_halfwidth_kana(unicodedata.normalize("NFC", text)).split())


def normalize_number(text: str) -> str:
    """Normalize a NUMBER field: NFC + half-width kana fold + the hyphen-equivalence class."""
    return fold_halfwidth_kana(unicodedata.normalize("NFC", text)).translate(_HYPHEN_TABLE).strip()


def split_street(street: str) -> tuple[str, int | None]:
    """Split an Overture ``street`` value into (district, chōme number or None).

    ``八島町二丁目`` → ``("八島町", 2)``; ``字崎枝`` → ``("字崎枝", None)``; ``二丁目`` → ``("", 2)``.
    A non-trailing 丁目 (2,316 rows) is left whole as the district — re-rendering a form we have not
    read is how a corpus grows labels nobody verified.
    """
    match = _CHOME_TAIL.match(street)
    if not match:
        return street, None
    value = kanji_to_int(match.group(2))
    if value is None:
        return street, None
    return match.group(1), value
