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


def pick_kana_stem(official: str, variants: Iterable[str]) -> str | None:
    """The kana STEM of a kanji official name: the shortest all-hiragana variant.

    ``variants`` for 厚木市 are あつぎ and あつぎし; the stem is あつぎ. An official name that is already hiragana has
    no stem to substitute and answers None, as does a name whose variants carry no hiragana at all.
    """
    if any(ord(ch) in _HIRAGANA for ch in official):
        return None
    kana = sorted({v for v in variants if is_hiragana(v)}, key=len)
    return kana[0] if kana else None


def kana_surface(official: str, stem: str) -> str:
    """The rendered municipality: the kana stem plus the official name's kanji generic, when it carries one."""
    generic = official[-1] if official.endswith(MUNICIPALITY_GENERICS) else ""
    return stem + generic


def municipality_kana_from_admin_db(db_path: Path | str) -> dict[str, str]:
    """Kanji official municipality name → kana surface, for every JP locality/localadmin the admin DB knows."""
    query = """
        SELECT s.id, n.name, n.privateuse
        FROM spr s JOIN names n ON n.id = s.id
        WHERE s.country = 'JP' AND s.placetype IN ('locality', 'localadmin') AND n.language = 'jpn'
    """
    official: dict[int, str] = {}
    variants: dict[int, list[str]] = {}
    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as db:
        for place_id, name, privateuse in db.execute(query):
            if privateuse == "preferred":
                official[place_id] = name
            elif privateuse == "variant":
                variants.setdefault(place_id, []).append(name)
    out: dict[str, str] = {}
    for place_id, name in official.items():
        stem = pick_kana_stem(name, variants.get(place_id, ()))
        if stem is not None:
            out[name] = kana_surface(name, stem)
    return out
