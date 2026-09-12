"""Reading the two inputs: the Overture-JP parquet, and KEN_ALL for the 〒 join.

The eligibility filter lives in the iterator so BOTH build passes see the identical row set — a
filter applied only in pass 2 would desynchronize the exact-selection masks.
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

#: Where each input sits under `$MAILWOMAN_DATA_ROOT`. Resolved after parsing, not here: reading the
#: root at import would raise for a caller who passes the flag and never needs it.
PARQUET_PARTS = ("overture", "2026-06-17.0", "addresses-jp.parquet")
KENALL_PARTS = ("KEN_ALL_ROME", "KEN_ALL_ROME.CSV")
ADMIN_DB_PARTS = ("wof", "admin-global-priority.db")

_KENALL_PAREN = re.compile(r"[（(].*?[）)]")
_KENALL_CATCH_ALL = "以下に掲載がない場合"
_AZA_PREFIX = re.compile(r"^(大字|字)")


class KenAllIndex:
    """The 〒 join: TOWN-level first, municipality catch-all only as the fallback.

    The probe joined at municipality granularity, which always returns the ``NNN-0000`` catch-all
    Japan Post lists first — so every probe row carried a postcode whose last four digits were
    ``0000``. Real Japanese postcodes are town-level, and KEN_ALL carries the town (``大字`` /
    ``町``) in column 4. Joining there instead makes the trailing digits real.

    The join needs one correction that is worth the measurement it took: Overture writes the ōaza
    prefix (``字崎枝``, ``大字上田``) and KEN_ALL does not. Exact town match alone hits **17.8%**
    of rows; retrying with a leading ``字``/``大字`` stripped takes it to **89.6%** (200k-row slice,
    2026-08-04). The remaining 10.4% falls back to the municipality catch-all, and nothing misses.
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

    Column layout: ``postcode, prefecture-kanji, city-kanji, town-kanji, …romaji``. Town names carry
    parenthetical annotations (``大通東（１～１３丁目）``) that are stripped, and the literal
    ``以下に掲載がない場合`` ("if not listed below") is the municipality catch-all, not a town.
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

    Eligibility, and why each rule exists — all four counts measured over the full 19,587,926 rows:

    - both address levels present + the prefecture in the canonical 47 (2 junk rows);
    - at least one of street/number non-empty (9 rows);
    - the number carries no comma (**35 rows**). Those are MLIT parcel AGGREGATIONS —
      ``岡山町1154,1153,1155,…`` up to 256 characters against a single coordinate. Rendered, they
      become one ``house_number`` span sixty parcels long, which is not a house number in any
      register a user types;
    - the field total fits ``max_field_chars`` (24 rows carry a number longer than 24 chars). This
      is the STRUCTURAL guard behind the semantic one: the char path runs at S=96 units and
      ``encode_row_units`` truncates silently, so a row that cannot fit is dropped here, counted,
      rather than half-labelled there.

    The filter lives in the iterator so BOTH passes see the identical row set — a filter applied
    only in pass 2 would desynchronize the exact-selection masks.

    Normalization happens here for the same reason.
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
