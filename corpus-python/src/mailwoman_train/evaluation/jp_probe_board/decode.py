"""Turning a per-character label sequence back into the surfaces a row claims.

This is the pre-registered span reconstruction and nothing else: contiguous B/I runs of the same
tag over the char sequence. It imports no torch, so the scoring above it is testable without a
checkpoint.
"""

from __future__ import annotations

import math
import unicodedata
from collections.abc import Mapping, Sequence


def norm_key(s: str) -> str:
    """The centroid table's key form: NFC, with ASCII and ideographic spaces stripped."""
    return "".join(unicodedata.normalize("NFC", s).split()).replace("　", "")


def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def decode_runs(raw: str, label_ids: Sequence[int], id_to_label: Mapping[int, str]) -> dict[str, list[tuple[int, int]]]:
    """Every contiguous B/I run per tag over the char sequence, in reading order, as ``[start, end)`` offsets."""
    runs: dict[str, list[tuple[int, int]]] = {}
    cur_tag: str | None = None
    cur_start = 0

    def close(end: int) -> None:
        if cur_tag is not None:
            runs.setdefault(cur_tag, []).append((cur_start, end))

    for i in range(min(len(raw), len(label_ids))):
        label = id_to_label[label_ids[i]] if label_ids[i] >= 0 else "O"
        if label == "O":
            close(i)
            cur_tag = None
            continue
        prefix, tag = label.split("-", 1)
        if prefix == "B" or tag != cur_tag:
            close(i)
            cur_tag, cur_start = tag, i
    close(min(len(raw), len(label_ids)))
    return runs


def decode_all_spans(raw: str, label_ids: Sequence[int], id_to_label: Mapping[int, str]) -> dict[str, list[str]]:
    """Every contiguous B/I run per tag over the char sequence, in reading order -> concatenated surfaces, plus the
    surface of each group of same-tag runs that only whitespace separates.

    A tag can legitimately occur more than once in one row: the KR ladder puts 읍/면 and the 리 below it, or the
    road-form's parenthetical 동, on the same ``dependent_locality`` tag (``신림면 구학리``), and ``수원시 장안구`` is two
    ``subregion`` spans. The per-tag read scores each gold span against this full list; collapsing to one span per
    tag guaranteed a miss on every such row, whatever the model emitted.

    The whitespace-joined surfaces are there for the multi-token spans the typed registries carry: the permit
    register's ``1층 141호`` is one ``unit`` field, and the model labels every character of it ``unit`` except the
    space, which it reads as ``O`` the way it does for every space in the 5,200,000 LABEL rows. The served projection
    joins adjacent same-tag runs with the raw's own whitespace and reports ``unit: "1층 141호"``, so the read does the
    same; on the aligned KR permit board the space alone accounted for 196 of 396 ``unit`` misses.
    """
    runs = decode_runs(raw, label_ids, id_to_label)
    spans: dict[str, list[str]] = {}
    for tag, offsets in runs.items():
        surfaces = [raw[s:e] for s, e in offsets]
        # Groups of two or more runs separated only by whitespace, each joined through the raw text.
        groups: list[tuple[int, int, int]] = []
        group_start, group_end, group_size = offsets[0][0], offsets[0][1], 1
        for s, e in offsets[1:]:
            if raw[group_end:s].strip() == "":
                group_end, group_size = e, group_size + 1
                continue
            groups.append((group_start, group_end, group_size))
            group_start, group_end, group_size = s, e, 1
        groups.append((group_start, group_end, group_size))
        for start, end, size in groups:
            if size > 1 and raw[start:end] not in surfaces:
                surfaces.append(raw[start:end])
        spans[tag] = surfaces
    return spans


def decode_spans(raw: str, label_ids: Sequence[int], id_to_label: Mapping[int, str]) -> dict[str, str]:
    """First contiguous B/I run per tag over the char sequence -> concatenated surface (the centroid-key read)."""
    return {tag: surfaces[0] for tag, surfaces in decode_all_spans(raw, label_ids, id_to_label).items()}
