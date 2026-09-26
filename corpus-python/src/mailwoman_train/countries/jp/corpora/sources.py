"""Reading the two inputs: the Overture-JP parquet and KEN_ALL for the 〒 join.

The eligibility filter lives in the iterator so both build passes see the identical row set; applying
it only in pass 2 would desynchronize the exact-selection masks.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterator
from pathlib import Path

import pyarrow.parquet as pq

from ....corpora.builder import MAX_FIELD_CHARS
from ....text.normalize import normalize_text
from ..text import JP_PREFECTURES, normalize_name, normalize_number

#: Where each input sits under `$MAILWOMAN_DATA_ROOT`. Resolved after parsing rather than at import, so a
#: caller who passes the flag and never needs it does not raise.
PARQUET_PARTS = ("overture", "2026-06-17.0", "addresses-jp.parquet")
KENALL_PARTS = ("KEN_ALL_ROME", "KEN_ALL_ROME.CSV")
ADMIN_DB_PARTS = ("db", "wof", "admin-global-priority.db")

_KENALL_PAREN = re.compile(r"[（(].*?[）)]")
_KENALL_CATCH_ALL = "以下に掲載がない場合"
_AZA_PREFIX = re.compile(r"^(大字|字)")


class KenAllIndex:
    """The 〒 join: TOWN-level first, municipality catch-all only as the fallback.

    KEN_ALL carries the town (``大字``/``町``) in column 4, and Overture writes the ōaza prefix
    (``字崎枝``, ``大字上田``) that KEN_ALL omits, so an exact town match is retried with a leading
    ``字``/``大字`` stripped before falling back to the municipality catch-all.
    """

    def __init__(self, town: dict[str, str], municipality: dict[str, str]) -> None:
        self.town = town
        self.municipality = municipality

    def lookup(self, prefecture: str, municipality: str, district: str) -> tuple[str | None, str]:
        """Return ``(postcode, tier)`` where tier ∈ town | town_aza_stripped | municipality | miss."""
        head = normalize_text(prefecture + municipality)
        if district:
            hit = self.town.get(head + normalize_text(district))
            if hit:
                return hit, "town"
            stripped = _AZA_PREFIX.sub("", district)
            if stripped != district:
                hit = self.town.get(head + normalize_text(stripped))
                if hit:
                    return hit, "town_aza_stripped"
        hit = self.municipality.get(head)
        return (hit, "municipality") if hit else (None, "miss")


def load_kenall_postcodes(path: Path) -> KenAllIndex:
    """Read KEN_ALL_ROME (cp932) into the two-tier index above.

    Column layout: ``postcode, prefecture-kanji, city-kanji, town-kanji, …romaji``. Parenthetical town
    annotations are stripped, and the literal ``以下に掲載がない場合`` ("if not listed below") is the
    municipality catch-all rather than a town.
    """
    town: dict[str, str] = {}
    municipality: dict[str, str] = {}
    for line in path.read_bytes().decode("cp932").splitlines():
        cells = [cell.strip('"') for cell in line.rstrip("\r\n").split(",")]
        if len(cells) < 6 or len(cells[0]) != 7 or not cells[0].isdigit():
            continue
        head = normalize_text(cells[1] + cells[2])
        municipality.setdefault(head, cells[0])
        name = _KENALL_PAREN.sub("", cells[3]).strip()
        if not name or name == _KENALL_CATCH_ALL:
            continue
        town.setdefault(head + normalize_text(name), cells[0])
    return KenAllIndex(town, municipality)


def iter_source_rows(
    parquet: Path,
    max_row_groups: int | None = None,
    max_field_chars: int = MAX_FIELD_CHARS,
    dropped: Counter[str] | None = None,
) -> Iterator[tuple[str, str, str, str, float, float]]:
    """Yield ``(prefecture, municipality, street, number, lon, lat)`` for every eligible source row.

    Eligibility, and why each rule exists:

    - both address levels present and the prefecture in the canonical 47;
    - at least one of street/number non-empty;
    - the number carries no comma — those are MLIT parcel AGGREGATIONS (``岡山町1154,1153,1155,…``),
      which render as one ``house_number`` span sixty parcels long;
    - the field total fits ``max_field_chars``. This is the structural guard behind the semantic one:
      the char path runs at S=96 units and ``encode_row_units`` truncates silently, so a row that
      cannot fit is dropped here, counted, rather than half-labelled there.

    Normalization happens here for the same reason the filter lives in the iterator.
    """
    handle = pq.ParquetFile(parquet)
    groups = (
        handle.metadata.num_row_groups
        if max_row_groups is None
        else min(max_row_groups, handle.metadata.num_row_groups)
    )
    columns = ["address_levels", "street", "number", "lon", "lat"]
    for index in range(groups):
        table = handle.read_row_group(index, columns=columns)
        levels = table["address_levels"].to_pylist()
        streets = table["street"].to_pylist()
        numbers = table["number"].to_pylist()
        lons = table["lon"].to_pylist()
        lats = table["lat"].to_pylist()
        for level, street, number, lon, lat in zip(levels, streets, numbers, lons, lats, strict=True):
            if not level or len(level) < 2:
                if dropped is not None:
                    dropped["levels"] += 1
                continue
            prefecture, municipality = level[0]["value"], level[1]["value"]
            if not prefecture or not municipality or prefecture not in JP_PREFECTURES:
                if dropped is not None:
                    dropped["junk_prefecture"] += 1
                continue
            if not street and not number:
                if dropped is not None:
                    dropped["empty"] += 1
                continue
            if number and "," in number:
                if dropped is not None:
                    dropped["parcel_list_number"] += 1
                continue
            street = normalize_name(street) if street else ""
            number = normalize_number(number) if number else ""
            if len(prefecture) + len(municipality) + len(street) + len(number) > max_field_chars:
                if dropped is not None:
                    dropped["too_long"] += 1
                continue
            yield (
                prefecture,
                municipality,
                street,
                number,
                lon,
                lat,
            )
