"""Kana readings for Japanese municipalities, from the admin DB's `names` table (#2165).

A municipality's official name is kanji (厚木市) and the corpus rows carry it that way, so a model sees a hiragana
municipality only where the official name IS hiragana — some fifty of Japan's 1,741 municipalities (かすみがうら市,
つくば市, さいたま市). Two from-scratch runs closed the municipality span before the trailing 市 on the one such name the
board holds out (#2165). The register this module feeds renders the municipality as its kana reading plus the kanji
generic (あつぎ市 for 厚木市), which is both a surface people type and the exact shape of the official kana names.

The readings come from WOF through the admin DB: for a JP locality or localadmin, ``names`` carries the official kanji
as ``jpn preferred`` and the hiragana readings as ``jpn variant`` — a stem (あつぎ) and a full form (あつぎし). The stem
is what the register wants; the generic stays kanji.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterable
from pathlib import Path

MUNICIPALITY_GENERICS = ("市", "町", "村", "区")

_HIRAGANA = range(0x3041, 0x3097)


def is_hiragana(text: str) -> bool:
    """True when every character is hiragana (the prolonged-sound mark ー counts; it appears inside readings)."""
    return bool(text) and all(ord(ch) in _HIRAGANA or ch == "ー" for ch in text)


GENERIC_READINGS: dict[str, tuple[str, ...]] = {
    "市": ("し",),
    "町": ("まち", "ちょう"),
    "村": ("むら", "そん"),
    "区": ("く",),
}

_KANA_PLACETYPES = ("locality", "localadmin", "county", "borough")


def is_kanji_name(text: str) -> bool:
    """A name with no kana and no Latin: the surface the corpus rows carry."""
    return bool(text) and not any(ord(ch) in _HIRAGANA or 0x30A1 <= ord(ch) <= 0x30FA or ch.isascii() for ch in text)


def pick_kana_stem(official: str, variants: Iterable[str]) -> str | None:
    """The kana STEM for a kanji name: the shortest all-hiragana variant, minus the generic's reading when only the
    full form exists (とっとりし for 鳥取市 → とっとり).

    An official name that is already hiragana has no stem to substitute and answers None, as does a name whose
    variants carry no hiragana at all.
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
    """The rendered municipality: the kana stem plus the official name's kanji generic, when it carries one."""
    generic = official[-1] if official.endswith(MUNICIPALITY_GENERICS) else ""
    return stem + generic


def municipality_kana_from_admin_db(db_path: Path | str) -> dict[str, str]:
    """Kanji municipality name → kana surface, over every JP locality / localadmin / county / borough the admin DB knows.

    WOF files a city as the bare stem (`鳥取` preferred, `鳥取市` a variant) and sometimes carries the reading on the
    `county` record for the same city, so every kanji jpn name a place has becomes a key, and readings from every
    record that names the same kanji are pooled before the stem is picked.
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
        # The reading belongs to the SHORTEST generic-bearing kanji name (北区); a longer name that ends with it carries
        # a prefix the reading does not cover (大阪市北区), which stays kanji: 大阪市きた区, never きた区.
        base = min(generic_names, key=len)
        stem = pick_kana_stem(base, kana)
        if stem is None:
            continue
        for kanji in generic_names:
            if kanji.endswith(base):
                out.setdefault(kanji, kanji[: -len(base)] + kana_surface(base, stem))
    return out


def municipality_kana_lookup(kana_by_municipality: dict[str, str], municipality: str) -> str | None:
    """The row's municipality as the corpus writes it, with the county prefix (中新川郡上市町 → 上市町) stripped when
    the full form has no reading."""
    direct = kana_by_municipality.get(municipality)
    if direct is not None:
        return direct
    head, sep, tail = municipality.partition("郡")
    if sep and tail:
        return kana_by_municipality.get(tail)
    return None
