"""Renders one Japanese address row in one register and verifies the record.

A register is one way of writing the same address. Most registers never occur in the source data,
so synthesis is their only route into the corpus. `RowRenderer` records each span as it appends the
field text, so the spans need no search-based alignment.
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

# This matches the probe corpus's source string. `source_weights` drops an unlisted source, so a new
# name would empty the feed of any config that weights "overture-jp".
SOURCE = "overture-jp"

_COMPACT = re.compile(r"^[0-9]+(?:-[0-9]+)*$")

# The sampler renormalizes these weights over the registers a row can render.
REGISTER_WEIGHTS: dict[str, float] = {
    # The source's own surface: kanji chōme and a compact banchi-go number.
    "native": 0.40,
    # The chōme in Arabic numerals (二丁目 becomes 2丁目). The source never writes it this way.
    "arabic_chome": 0.25,
    # The chōme folded into the house number (八島町2-3-16).
    "compact_folded": 0.20,
    # The number written with designators (3番16号), which emits the sub_block and building_number tags.
    "designator": 0.15,
    # The municipality as its kana reading plus the kanji generic (あつぎ市). It is available only when
    # `countries/jp/kana.py` finds a reading in the admin DB.
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
    """Render one JP row in one register and return its span-triple corpus record.

    Components run from largest to smallest. ``spaced`` puts one ASCII space between the admin
    components. The 〒 mark sits outside the postcode span, which covers only the digits.
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
        # The chōme becomes the first part of a single house_number span.
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
    # The corpus schema requires the legacy token columns, although the char path ignores them. Each
    # whitespace token takes the tag of the span that covers its first character.
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
    """Return the registers this row can render.

    A number with non-digit parts (``362B-2``) renders only in the native register. A row without a
    chōme also allows the designator register. ``kana`` is true when the municipality has a kana
    reading, which enables the kana_municipality register.
    """
    clean = bool(_COMPACT.match(number)) if number else False
    kana_extra = ("kana_municipality",) if kana else ()
    if not clean:
        return ("native", *kana_extra)
    if chome is None:
        return ("native", "designator", *kana_extra)
    return tuple(name for name in REGISTER_WEIGHTS if kana or name != "kana_municipality")


def choose_register(rng: random.Random, options: Sequence[str]) -> str:
    """Pick one of ``options`` at random, weighted by ``REGISTER_WEIGHTS``."""
    if len(options) == 1:
        return options[0]
    weights = [REGISTER_WEIGHTS[name] for name in options]
    return rng.choices(options, weights=weights, k=1)[0]


def verify_record(record: dict[str, Any], tag_set: frozenset[str]) -> None:
    """Verify a record against the shared corpus rules and this corpus's label set."""
    _verify_record(record, tag_set, label_set_name=LABEL_SET_NAME)
