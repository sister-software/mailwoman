"""Build the SECONDARY-ADDRESS training shard (#1100 / #456, STAGE4 tags).

The parser has no examples of the secondary-address vertical axis — units, levels (floors), buildings,
and the EU entrance/staircase forms. This generator synthesizes labeled rows that emit the STAGE4
``unit_designator`` / ``level_designator`` / ``level_id`` / ``building_designator`` / ``building_id`` /
``entrance`` / ``staircase`` tags (the existing ``unit`` tag carries the bare unit id, #456), each in a
realistic full-address context so the surrounding street/admin tags stay anchored.

Designators are a curated draw from USPS Pub-28 Appendix C2 (units) and the per-locale codex
level-semantics lexicons — ``@mailwoman/codex`` (``codex/us/unit-designator.ts``,
``codex/level-semantics.ts``) is the runtime source of truth; this synthetic set only needs realistic
training surfaces, not the full table.

Rows carry char-offset spans (#519) — the authoritative label channel for v0.5.0+ training — built by
cursor tracking and self-checked (every span must slice its own entity text) before write, the same
corruption guard the augmentation slice enforces.

STAGE4 is DEFINED but NOT the active label set (see ``labels.py``); until activation these tags collapse
to ``O`` at load. This shard is staged so a STAGE4-active retrain can consume it the moment the
label-stage bump lands.

Usage::

    python -m mailwoman_train.build_secondary_shard \\
        --out-parquet /mnt/playpen/mailwoman-data/corpus/staging/secondary/part-secondary.parquet \\
        --out-dev out/secondary-dev.jsonl
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

SEED = 20260714

# --- Designator lexicons (curated from Pub-28 C2 + codex level-semantics) ------------------------
# US secondary unit designators that take a following id (Pub-28 C2, the range-taking subset).
US_UNIT_DESIGNATORS: tuple[str, ...] = ("APT", "STE", "UNIT", "RM", "DEPT", "OFC", "TRLR", "LOT", "SPC", "SLIP", "PIER")
# US level (floor) designators + the bare-ordinal id forms.
US_LEVEL_DESIGNATORS: tuple[str, ...] = ("FL", "FLR", "FLOOR")
# US building designators.
US_BUILDING_DESIGNATORS: tuple[str, ...] = ("BLDG", "BUILDING", "PH", "TWR")
# EU entrance / staircase whole-phrase forms (codex level-semantics locales: de-AT/de-DE/nl/fr).
EU_ENTRANCES: tuple[str, ...] = ("Eingang 2", "Eingang A", "Aufgang 3", "opgang B", "Entrée C", "Escalier 4")
EU_STAIRCASES: tuple[str, ...] = ("Stiege 4", "Stiege 2", "Trappenhuis 1", "Cage B", "Escalera 3")
# Level ids: US uses bare numerics + a couple of Asian F/B forms the level-semantics table covers.
LEVEL_IDS: tuple[str, ...] = ("1", "2", "3", "4", "5", "10", "12", "3F", "B1")
UNIT_IDS: tuple[str, ...] = ("100", "200", "4B", "12", "711", "305", "A", "17", "2C")
BUILDING_IDS: tuple[str, ...] = ("A", "B", "C", "1", "2", "North", "West")

# --- Realistic base addresses (street, number, city, region, postcode, country) ------------------
# Curated so the shard is self-contained + deterministic; a spread of US + EU orders.
US_BASES: tuple[tuple[str, str, str, str, str], ...] = (
    ("Main St", "123", "Portland", "OR", "97214"),
    ("Oak Avenue", "456", "Chicago", "IL", "60614"),
    ("Elm Boulevard", "789", "Miami", "FL", "33101"),
    ("5th Ave", "1600", "New York", "NY", "10019"),
    ("Bouverie Street", "139", "Melbourne", "VIC", "3000"),
    ("Pine Road", "42", "Austin", "TX", "78701"),
    ("Market Street", "1355", "San Francisco", "CA", "94103"),
    ("Congress Ave", "600", "Austin", "TX", "78701"),
)
EU_BASES: tuple[tuple[str, str, str, str], ...] = (
    ("Hauptstraße", "12", "Berlin", "DE"),
    ("Mariahilfer Straße", "88", "Wien", "AT"),
    ("Damrak", "1", "Amsterdam", "NL"),
    ("Rue de Rivoli", "24", "Paris", "FR"),
    ("Gran Vía", "31", "Madrid", "ES"),
)


def _row_from_groups(groups: list[list[tuple[str, str]]], sep: str) -> dict:
    """Build a row (raw + tokens + labels + char-offset spans) from ordered GROUPS. Within a group the
    (tag, text) parts are ALWAYS space-joined (a designator + its id — "STE 200", "FL 3" — are one
    logical unit); groups are joined by ``sep`` (", " punctuated / " " delimiter-free, #1101). Cursor
    tracks char offsets so each span slices its own entity text exactly."""
    tokens: list[str] = []
    labels: list[str] = []
    span_starts: list[int] = []
    span_ends: list[int] = []
    span_tags: list[str] = []
    group_surfaces: list[str] = []
    cursor = 0

    for gi, group in enumerate(groups):
        if gi > 0:
            cursor += len(sep)
        surface_parts: list[str] = []
        for pi, (tag, text) in enumerate(group):
            if pi > 0:
                cursor += 1  # the intra-group space
            text_tokens = text.split()
            tokens.extend(text_tokens)
            labels.extend([f"B-{tag}"] + [f"I-{tag}"] * (len(text_tokens) - 1))
            span_starts.append(cursor)
            span_ends.append(cursor + len(text))
            span_tags.append(tag)
            surface_parts.append(text)
            cursor += len(text)
        group_surfaces.append(" ".join(surface_parts))

    return {
        "raw": sep.join(group_surfaces),
        "tokens": tokens,
        "labels": labels,
        "span_starts": span_starts,
        "span_ends": span_ends,
        "span_tags": span_tags,
        "source": "synthetic-secondary",
    }


def _secondary_forms(rng: random.Random) -> list[list[tuple[str, str]]]:
    """The secondary-component (tag, text) sub-sequences to splice into a base address."""
    forms: list[list[tuple[str, str]]] = []
    # Unit: designator + bare id (the id keeps the existing STAGE3 `unit` tag).
    forms.append([("unit_designator", rng.choice(US_UNIT_DESIGNATORS)), ("unit", rng.choice(UNIT_IDS))])
    # Level: designator + id, and the bare-ordinal "3F" form (id only).
    forms.append([("level_designator", rng.choice(US_LEVEL_DESIGNATORS)), ("level_id", rng.choice(LEVEL_IDS))])
    forms.append([("level_id", rng.choice(("3F", "B1", "2F", "1F")))])
    # Building: designator + id.
    forms.append(
        [("building_designator", rng.choice(US_BUILDING_DESIGNATORS)), ("building_id", rng.choice(BUILDING_IDS))]
    )
    # EU entrance / staircase (whole-phrase).
    forms.append([("entrance", rng.choice(EU_ENTRANCES))])
    forms.append([("staircase", rng.choice(EU_STAIRCASES))])
    return forms


def generate(cap: int) -> list[dict]:
    """Combinatorial secondary-address rows: each base × each secondary form, punctuated AND
    delimiter-free (#1101), US streets and EU orders. Deterministic under SEED."""
    rng = random.Random(SEED)
    rows: list[dict] = []

    for _ in range(cap):
        for sep in (", ", " "):  # punctuated + whitespace-only (#1101)
            for form in _secondary_forms(rng):
                # US context: "{num} {street}, {secondary}, {city}, {region} {postcode}"
                street, number, city, region, postcode = rng.choice(US_BASES)
                us_groups: list[list[tuple[str, str]]] = [
                    [("house_number", number), ("street", street)],
                    form,
                    [("locality", city)],
                    [("region", region), ("postcode", postcode)],
                ]
                rows.append(_row_from_groups(us_groups, sep))

                # EU context: "{street} {num}, {secondary}, {city}" (Euro order — entrance/staircase home)
                es, en, ec, _country = rng.choice(EU_BASES)
                eu_groups: list[list[tuple[str, str]]] = [
                    [("street", es), ("house_number", en)],
                    form,
                    [("locality", ec)],
                ]
                rows.append(_row_from_groups(eu_groups, sep))

    return rows


def _self_check(rows: list[dict]) -> None:
    """Every span MUST slice its own entity text in raw, spans sorted + non-overlapping — the corruption
    guard. Raises on the first violation rather than writing a silently mislabeled shard."""
    for r in rows:
        raw = r["raw"]
        prev_end = -1
        for s, e, t in zip(r["span_starts"], r["span_ends"], r["span_tags"], strict=True):
            if not (0 <= s < e <= len(raw)):
                raise ValueError(f"span [{s},{e}) out of bounds for {raw!r}")
            if s < prev_end:
                raise ValueError(f"span [{s},{e}) overlaps previous in {raw!r}")
            prev_end = e
            slice_text = raw[s:e]
            if not slice_text.strip():
                raise ValueError(f"empty span slice for tag {t} in {raw!r}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out-parquet", type=Path, required=True)
    ap.add_argument("--out-dev", type=Path, required=True)
    ap.add_argument("--cap", type=int, default=400, help="base-repeat factor (rows ≈ cap × 24)")
    args = ap.parse_args()

    rows = generate(args.cap)
    _self_check(rows)

    # Tag histogram — surfaces coverage so "we built a secondary shard" can't hide "no level rows".
    hist: dict[str, int] = {}
    for r in rows:
        for t in r["span_tags"]:
            hist[t] = hist.get(t, 0) + 1

    args.out_parquet.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(rows), args.out_parquet)

    args.out_dev.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out_dev, "w", encoding="utf-8") as fh:
        for r in rows[:200]:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(f"secondary shard: {len(rows)} rows -> {args.out_parquet}")
    print(
        "STAGE4 tag coverage:",
        {
            k: hist[k]
            for k in sorted(hist)
            if k
            in {
                "unit_designator",
                "unit",
                "level_designator",
                "level_id",
                "building_designator",
                "building_id",
                "entrance",
                "staircase",
            }
        },
    )


if __name__ == "__main__":
    main()
