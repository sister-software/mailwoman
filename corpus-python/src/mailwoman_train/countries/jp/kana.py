"""Reads kana readings for Japanese municipalities from the admin DB's `names` table.

The kana_municipality register renders a municipality as its hiragana stem plus the kanji generic
(あつぎ市 for 厚木市). That shape matches the few municipalities whose official names are hiragana,
such as かすみがうら市.

For a JP place, ``names`` holds the official kanji as a ``jpn`` name and the hiragana readings as
``jpn`` variants. A reading may be a bare stem (あつぎ) or a full form that includes the generic (あつぎし).
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterable
from pathlib import Path

MUNICIPALITY_GENERICS = ("市", "町", "村", "区")

_HIRAGANA = range(0x3041, 0x3097)


def is_hiragana(text: str) -> bool:
    """Return True when the text is non-empty and every character is hiragana or the prolonged-sound mark ー."""
    return bool(text) and all(ord(ch) in _HIRAGANA or ch == "ー" for ch in text)


GENERIC_READINGS: dict[str, tuple[str, ...]] = {
    "市": ("し",),
    "町": ("まち", "ちょう"),
    "村": ("むら", "そん"),
    "区": ("く",),
}

_KANA_PLACETYPES = ("locality", "localadmin", "county", "borough")


def is_kanji_name(text: str) -> bool:
    """Return True when the text is non-empty and contains neither kana nor ASCII characters."""
    return bool(text) and not any(ord(ch) in _HIRAGANA or 0x30A1 <= ord(ch) <= 0x30FA or ch.isascii() for ch in text)


def pick_kana_stem(official: str, variants: Iterable[str]) -> str | None:
    """Return the kana stem for a kanji name, or None when there is none.

    The stem is the shortest all-hiragana variant. When that variant ends with the generic's reading,
    the reading is removed (とっとりし for 鳥取市 becomes とっとり). An official name that already contains
    hiragana returns None.
    """
    if any(ord(ch) in _HIRAGANA for ch in official):
        return None
    kana = sorted({v for v in variants if is_hiragana(v)}, key=len)
    if not kana:
        return None
    stem = kana[0]
    generic = official[-1] if official.endswith(MUNICIPALITY_GENERICS) else None
    if generic:
        for reading in GENERIC_READINGS[generic]:
            if stem.endswith(reading) and len(stem) > len(reading):
                return stem[: -len(reading)]
    return stem


def kana_surface(official: str, stem: str) -> str:
    """Return the kana stem followed by the official name's kanji generic, if it has one."""
    generic = official[-1] if official.endswith(MUNICIPALITY_GENERICS) else ""
    return stem + generic


def municipality_kana_from_admin_db(db_path: Path | str) -> dict[str, str]:
    """Map each kanji municipality name to its kana surface.

    The query covers JP localities, localadmins, counties and boroughs. WOF may store a city's
    preferred name without the generic (鳥取) and list the generic form (鳥取市) as a variant, so every
    kanji name of a place that ends with a generic becomes a key.
    """
    query = """
        SELECT s.id, n.name, n.privateuse
        FROM spr s JOIN names n ON n.id = s.id
        WHERE s.country = 'JP' AND s.placetype IN ('locality', 'localadmin', 'county', 'borough') AND n.language = 'jpn'
    """
    kanji_by_place: dict[int, list[str]] = {}
    kana_by_place: dict[int, list[str]] = {}
    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as db:
        for place_id, name, _privateuse in db.execute(query):
            if is_hiragana(name):
                kana_by_place.setdefault(place_id, []).append(name)
            elif is_kanji_name(name):
                kanji_by_place.setdefault(place_id, []).append(name)
    out: dict[str, str] = {}
    for place_id, kanji_names in kanji_by_place.items():
        kana = kana_by_place.get(place_id)
        if not kana:
            continue
        generic_names = [name for name in kanji_names if name.endswith(MUNICIPALITY_GENERICS)]
        if not generic_names:
            continue
        # The reading covers the shortest generic name (北区). A longer name that ends with it keeps its
        # extra prefix in kanji, so 大阪市北区 becomes 大阪市きた区.
        base = min(generic_names, key=len)
        stem = pick_kana_stem(base, kana)
        if stem is None:
            continue
        for kanji in generic_names:
            if kanji.endswith(base):
                out.setdefault(kanji, kanji[: -len(base)] + kana_surface(base, stem))
    return out


def municipality_kana_lookup(kana_by_municipality: dict[str, str], municipality: str) -> str | None:
    """Return the kana surface for a corpus municipality, or None when no reading exists.

    When the full name has no reading, the lookup retries without the county prefix
    (中新川郡上市町 becomes 上市町).
    """
    direct = kana_by_municipality.get(municipality)
    if direct is not None:
        return direct
    head, sep, tail = municipality.partition("郡")
    if sep and tail:
        return kana_by_municipality.get(tail)
    return None
