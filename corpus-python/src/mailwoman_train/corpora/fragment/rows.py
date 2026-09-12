"""Turning a harvested surface into a labeled row.

Each renderer builds `raw` by joining pieces and the char offsets by advancing a cursor over the
same pieces, so the two can disagree without anything downstream noticing — the char label array
is painted from the offsets, and a row labelling the wrong characters still trains and still
scores. `tests/mailwoman_train/corpora/test_fragment_rows.py` asserts the agreement: every span
must cover the surface it claims, and the span tags must name the same fields as the BIO labels.
"""

from __future__ import annotations

import json
from typing import Any

from ...paths import package_path

COUNTRY_NAMES = {
    "AT": "Austria",
    "CH": "Switzerland",
    "CZ": "Czech Republic",
    "DK": "Denmark",
    "ES": "Spain",
    "FI": "Finland",
    "HR": "Croatia",
    "NL": "Netherlands",
    "NO": "Norway",
    "PL": "Poland",
    "PT": "Portugal",
    "SE": "Sweden",
    "SI": "Slovenia",
    "SK": "Slovakia",
    "AU": "Australia",
    "NZ": "New Zealand",
}

# Country surfaces come from @mailwoman/codex (COUNTRY_SURFACE_FORMS + ISO2_TO_NAME), NOT re-derived
# here — the codex is the single source of truth. `codex/tools/export-country-surfaces.ts` snapshots it
# across the TS→Python boundary into the data file below (regenerate it when the codex changes). Filter
# to word-forms (len ≥ 3) so an address TAIL is "USA" / "United States", never the bare "US" alpha-2
# code (ambiguous with a US state code at the tail). Golden gold IS the surface, e.g.
# "6220 SE Salmon St, Portland, OR 97215, USA" → country="USA".
_COUNTRY_SURFACES_RAW = json.loads(package_path("data", "country-surfaces.json").read_text(encoding="utf-8"))[
    "surfaces"
]
COUNTRY_SURFACES: dict[str, list[str]] = {
    iso2: [f for f in forms if len(f) >= 3] for iso2, forms in _COUNTRY_SURFACES_RAW.items()
}
COUNTRY_SURFACES = {iso2: forms for iso2, forms in COUNTRY_SURFACES.items() if forms}


def render(surface: str, number: str | None, tag: str = "street") -> dict[str, Any]:
    """Render a fragment row with by-construction BIO labels + char spans (tag: street|locality)."""
    surface_tokens = surface.split()
    tokens = list(surface_tokens)
    labels = [f"B-{tag}"] + [f"I-{tag}"] * (len(surface_tokens) - 1)
    text = surface

    if number:
        tokens.append(number)
        labels.append("B-house_number")
        text = f"{surface} {number}"

    # Char spans: the surface covers [0, len(surface)); the number starts after the joining space.
    span_starts, span_ends, span_tags = [0], [len(surface)], [tag]

    if number:
        span_starts.append(len(surface) + 1)
        span_ends.append(len(text))
        span_tags.append("house_number")

    return {
        "raw": text,
        "tokens": tokens,
        "labels": labels,
        "span_starts": span_starts,
        "span_ends": span_ends,
        "span_tags": span_tags,
    }


def render_locality_postcode(city: str, postcode: str) -> dict[str, Any]:
    """Slice-v2 (v251 read-out): the "Eight Mile Plains 4113" class — locality + trailing postcode."""
    tokens = city.split() + [postcode]
    labels = ["B-locality"] + ["I-locality"] * (len(city.split()) - 1) + ["B-postcode"]
    text = f"{city} {postcode}"

    return {
        "raw": text,
        "tokens": tokens,
        "labels": labels,
        "span_starts": [0, len(city) + 1],
        "span_ends": [len(city), len(text)],
        "span_tags": ["locality", "postcode"],
    }


def render_context(
    street: str, number: str, city: str, country: str, trailing: bool, with_country: bool
) -> dict[str, Any]:
    """Slice-v4: COMMA-FREE context rows — the failure-census headline class (71/143 street misses
    were unpunctuated street<->admin boundaries: "Rue Henri Barbusse Paris France"). Euro order
    STREET NUMBER CITY [COUNTRY]; en order NUMBER STREET CITY [COUNTRY]. No punctuation anywhere."""
    parts: list[tuple[str, str]] = []  # (tag, text)

    if trailing:
        parts = [("street", street), ("house_number", number), ("locality", city)]
    else:
        parts = [("house_number", number), ("street", street), ("locality", city)]

    if with_country:
        parts.append(("country", COUNTRY_NAMES[country]))

    tokens: list[str] = []
    labels: list[str] = []
    span_starts: list[int] = []
    span_ends: list[int] = []
    span_tags: list[str] = []
    cursor = 0
    pieces: list[str] = []

    for tag, text in parts:
        text_tokens = text.split()
        tokens.extend(text_tokens)
        labels.extend([f"B-{tag}"] + [f"I-{tag}"] * (len(text_tokens) - 1))
        span_starts.append(cursor)
        span_ends.append(cursor + len(text))
        span_tags.append(tag)
        pieces.append(text)
        cursor += len(text) + 1

    return {
        "raw": " ".join(pieces),
        "tokens": tokens,
        "labels": labels,
        "span_starts": span_starts,
        "span_ends": span_ends,
        "span_tags": span_tags,
    }


def render_unit(unit: str, number: str, street: str) -> dict[str, Any]:
    """Slice-v2: AU compact unit rows — "UNIT 711 139 BOUVERIE STREET" (unit, house_number, street)."""
    unit_tokens, street_tokens = unit.split(), street.split()
    tokens = unit_tokens + [number] + street_tokens
    labels = (
        ["B-unit"]
        + ["I-unit"] * (len(unit_tokens) - 1)
        + ["B-house_number"]
        + ["B-street"]
        + ["I-street"] * (len(street_tokens) - 1)
    )
    text = f"{unit} {number} {street}"
    number_start = len(unit) + 1
    street_start = number_start + len(number) + 1

    return {
        "raw": text,
        "tokens": tokens,
        "labels": labels,
        "span_starts": [0, number_start, street_start],
        "span_ends": [len(unit), number_start + len(number), len(text)],
        "span_tags": ["unit", "house_number", "street"],
    }


def render_admin_pair(locality: str, region: str) -> dict[str, Any]:
    """US "LOCALITY REGION" comma-free pair — the locality<->region boundary row."""
    locality_tokens, region_tokens = locality.split(), region.split()
    tokens = locality_tokens + region_tokens
    labels = (
        ["B-locality"]
        + ["I-locality"] * (len(locality_tokens) - 1)
        + ["B-region"]
        + ["I-region"] * (len(region_tokens) - 1)
    )
    text = f"{locality} {region}"

    return {
        "raw": text,
        "tokens": tokens,
        "labels": labels,
        "span_starts": [0, len(locality) + 1],
        "span_ends": [len(locality), len(text)],
        "span_tags": ["locality", "region"],
    }


def render_country_context(
    street: str, number: str, city: str, country_name: str, trailing: bool, comma: bool
) -> dict[str, Any]:
    """#1104 country counterweight: a full address ENDING in a country token, comma'd OR comma-free, so the
    fine-tune keeps the country class alive — the slice-v5 mass (bare streets/localities/admin pairs) is
    country-SPARSE and eroded country recall 88.6%→82.0%. Fields are groups (number+street space-joined as
    one unit); groups are joined by ", " (comma'd) or " " (comma-free). Cursor-tracks char-offset spans."""
    groups: list[list[tuple[str, str]]] = (
        [[("street", street), ("house_number", number)]]
        if trailing
        else [[("house_number", number), ("street", street)]]
    )
    groups += [[("locality", city)], [("country", country_name)]]
    sep = ", " if comma else " "

    tokens: list[str] = []
    labels: list[str] = []
    span_starts: list[int] = []
    span_ends: list[int] = []
    span_tags: list[str] = []
    surfaces: list[str] = []
    cursor = 0

    for gi, group in enumerate(groups):
        if gi > 0:
            cursor += len(sep)
        parts: list[str] = []

        for pi, (tag, text) in enumerate(group):
            if pi > 0:
                cursor += 1  # intra-group space
            text_tokens = text.split()
            tokens.extend(text_tokens)
            labels.extend([f"B-{tag}"] + [f"I-{tag}"] * (len(text_tokens) - 1))
            span_starts.append(cursor)
            span_ends.append(cursor + len(text))
            span_tags.append(tag)
            parts.append(text)
            cursor += len(text)
        surfaces.append(" ".join(parts))

    return {
        "raw": sep.join(surfaces),
        "tokens": tokens,
        "labels": labels,
        "span_starts": span_starts,
        "span_ends": span_ends,
        "span_tags": span_tags,
    }


def render_country_leading(surface: str, region: str, locality: str) -> dict[str, Any]:
    """#1104 v2.9.1: a LEADING-position country admin row — "United States of America, Wyoming, Лорейн"
    (country FIRST, then region, then locality). This is the golden WOF-admin distribution the v290
    tail-only counterweight missed; the locality may be NON-Latin (transliterated WOF alt-names), which
    is the point — it teaches country recognition when the locality context is non-Latin. Comma-joined
    single-token-per-field groups; cursor-tracked spans."""
    fields = [("country", surface), ("region", region), ("locality", locality)]
    tokens: list[str] = []
    labels: list[str] = []
    span_starts: list[int] = []
    span_ends: list[int] = []
    span_tags: list[str] = []
    pieces: list[str] = []
    cursor = 0

    for i, (tag, text) in enumerate(fields):
        if i > 0:
            cursor += 2  # ", "
        text_tokens = text.split()
        tokens.extend(text_tokens)
        labels.extend([f"B-{tag}"] + [f"I-{tag}"] * (len(text_tokens) - 1))
        span_starts.append(cursor)
        span_ends.append(cursor + len(text))
        span_tags.append(tag)
        pieces.append(text)
        cursor += len(text)

    return {
        "raw": ", ".join(pieces),
        "tokens": tokens,
        "labels": labels,
        "span_starts": span_starts,
        "span_ends": span_ends,
        "span_tags": span_tags,
    }
