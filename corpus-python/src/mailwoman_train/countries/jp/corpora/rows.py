"""Rendering one Japanese address in one register, and verifying what came out.

A register is a way of writing the SAME address: the source's own surface, the chōme in Arabic
numerals, the chōme folded into the number, the long designator form, or the municipality as its
kana reading. The corpus carries all of them because a user types all of them, and three of the
five appear in zero source rows — synthesis is the only way they reach the model.

Spans are emitted BY CONSTRUCTION through `RowRenderer`: the raw string is concatenated from
labeled field values and each span is recorded as it lands, so there is no search-based
re-alignment to drift.
"""

from __future__ import annotations

import random
import re
from collections.abc import Sequence
from typing import Any

from ....corpora.builder import RowRenderer
from ....corpora.builder import verify_record as _verify_record
from ....text.kana import int_to_kanji

LABEL_SET_NAME = "stage3-jp"

# Same source string as the probe slice. An unlisted source is DROPPED by ``source_weights``, so a
# new name would silently empty the feed of any config that names the probe's — the corpus_dir
# already distinguishes the two slices.
SOURCE = "overture-jp"

_COMPACT = re.compile(r"^[0-9]+(?:-[0-9]+)*$")

# The registers. Weights are renormalized over whatever is AVAILABLE for a row (a street with no
# chōme cannot render `arabic_chome` or `compact_folded`), and the build report prints the counts
# that actually landed rather than the intent.
REGISTER_WEIGHTS: dict[str, float] = {
    # The source's own surface: kanji chōme + compact banchi-go. The postal-official register.
    "native": 0.40,
    # 二丁目 → 2丁目. Ubiquitous in typed input and ABSENT from the source (0 of 3,139,164).
    "arabic_chome": 0.25,
    # Chōme folded into the number: 八島町2-3-16. This is D4's named compact form, and the 3-part
    # compact number appears in ZERO source rows — only synthesis puts it in front of the model.
    "compact_folded": 0.20,
    # 3番16号 — designators in the surface, so the JP-seven number tags fire (D4's two-surface rule).
    "designator": 0.15,
    # あつぎ市 — the municipality as its kana reading plus the kanji generic (#2165): the shape of the official kana
    # names (かすみがうら市) that two from-scratch runs failed to close at the 市. Native rendering otherwise.
    # Available only where the admin DB reads the municipality (jp_kana.py).
    "kana_municipality": 0.05,
}


def render_row(
    *,
    prefecture: str,
    municipality: str,
    district: str,
    chome: int | None,
    number: str,
    postcode: str | None,
    register: str,
    spaced: bool,
    country: bool,
    hyphen: str = "-",
    municipality_kana: str | None = None,
) -> dict[str, Any]:
    """Render one JP row in one register, returning the #519 span-triple slice record.

    Order is native large-to-small and space-free by default (``spaced`` inserts single ASCII spaces
    between the admin components, which real typed input does carry). The 〒 mark stays OUTSIDE the
    postcode span — the span is the digits, mirroring the Latin convention.
    """
    renderer = RowRenderer()
    sep = " " if spaced else ""

    if postcode:
        renderer.glue("〒")
        renderer.put("postcode", f"{postcode[:3]}-{postcode[3:]}")
        renderer.glue(" ")
    if country:
        renderer.put("country", "日本")
        renderer.glue(sep)
    renderer.put("prefecture", prefecture)
    renderer.glue(sep)
    if register == "kana_municipality":
        if not municipality_kana:
            raise ValueError("kana_municipality register needs municipality_kana")
        renderer.put("municipality", municipality_kana)
    else:
        renderer.put("municipality", municipality)
    renderer.glue(sep)

    parts = number.split("-") if number else []

    if register == "compact_folded":
        # The chōme becomes the leading part of one whole-span house_number (D4).
        renderer.put("district", district)
        renderer.put("house_number", hyphen.join([str(chome), *parts]))
    elif register == "designator":
        renderer.put("district", district)
        if chome is not None:
            renderer.put("block", f"{int_to_kanji(chome)}丁目")
        if len(parts) >= 2:
            renderer.put("sub_block", f"{parts[0]}番")
            renderer.put("building_number", f"{parts[1]}号")
            for extra in parts[2:]:
                renderer.put("house_number", extra)
        elif parts:
            renderer.put("sub_block", f"{parts[0]}番地")
    else:
        renderer.put("district", district)
        if chome is not None:
            block = f"{chome}丁目" if register == "arabic_chome" else f"{int_to_kanji(chome)}丁目"
            renderer.put("block", block)
        if number:
            renderer.put("house_number", hyphen.join(parts) if parts else number)

    raw = renderer.raw
    # Legacy token columns (the char path ignores them; the slice schema requires them): whitespace
    # tokens labeled by the span covering their first character — honest at the token grain.
    tokens: list[str] = []
    labels: list[str] = []
    cursor = 0
    for token in raw.split():
        index = raw.find(token, cursor)
        cursor = index + len(token)
        label = "O"
        for start, end, tag in zip(renderer.starts, renderer.ends, renderer.tags, strict=True):
            if start <= index < end:
                label = f"B-{tag}"
                break
        tokens.append(token)
        labels.append(label)

    return {
        "raw": raw,
        "tokens": tokens,
        "labels": labels,
        "span_starts": renderer.starts,
        "span_ends": renderer.ends,
        "span_tags": renderer.tags,
        "country": "JP",
        "source": SOURCE,
        "register": register,
    }


def available_registers(chome: int | None, number: str, kana: bool = False) -> tuple[str, ...]:
    """Which registers a row can honestly render.

    A row with no chōme has no chōme register to convert; a number that is not a clean part list
    (``362B-2``, ``761乙号-2`` — 103,299 rows) cannot be re-rendered as designators at all, so it
    stays whole-span in its native surface. ``kana`` says whether the municipality has a kana
    reading to render (#2165); without one the kana register is not on offer.
    """
    clean = bool(_COMPACT.match(number)) if number else False
    kana_extra = ("kana_municipality",) if kana else ()
    if not clean:
        return ("native", *kana_extra)
    if chome is None:
        return ("native", "designator", *kana_extra)
    return tuple(name for name in REGISTER_WEIGHTS if kana or name != "kana_municipality")


def choose_register(rng: random.Random, options: Sequence[str]) -> str:
    if len(options) == 1:
        return options[0]
    weights = [REGISTER_WEIGHTS[name] for name in options]
    return rng.choices(options, weights=weights, k=1)[0]


def verify_record(record: dict[str, Any], tag_set: frozenset[str]) -> None:
    """The shared verifier bound to this corpus's label set."""
    _verify_record(record, tag_set, label_set_name=LABEL_SET_NAME)
