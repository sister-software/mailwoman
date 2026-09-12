"""The two measuring passes: what the register holds, and what the permits align to.

Neither draws from the RNG and neither writes a row. Pass 1 reads the register to count eligible
rows per 시도 and to BUILD THE KEY INDEX; pass 2 reads the permits, which can only be aligned once
that index exists, and averages their coordinates per 시군구. Everything the selecting half needs
from the sources comes back in the two records below.

`transform_coordinates` is reached through the `registers` module rather than bound by name, so a
test that stands in for `gdaltransform` patches one function and both callers see it.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from ....corpora.builder import muni_bucket, water_fill
from .. import registers
from ..juso import alias_key_index, empty_key_index, index_label_row, iter_label_rows
from ..registers import KeyIndex
from .rows import eligible, permit_alignment, unit_key

#: How many permit points are projected in one `gdaltransform` process.
PROJECTION_BATCH = 200_000


@dataclass(frozen=True)
class RegisterSurvey:
    """Pass 1's answer: the key index every later pass reads, plus the quotas pass 3 selects under."""

    index: KeyIndex
    scanned: int
    dropped: Counter[str]
    pool_counts: Counter[str]
    board_count: int
    cap: int
    quotas: dict[str, int]


@dataclass
class PermitSurvey:
    """Pass 2's answer: the alignment census, the per-시군구 centroids, and the pool sizes pass 4 selects from."""

    census_form: Counter[str] = field(default_factory=Counter)
    census_category: dict[str, Counter[str]] = field(default_factory=dict)
    centroids: dict[str, list[float]] = field(default_factory=dict)
    registry_pool: int = 0
    registry_board_pool: int = 0
    unaligned_pool: int = 0


def survey_register(juso_zip: Path, args: argparse.Namespace) -> RegisterSurvey:
    """Pass 1: count eligible rows per 시도, build the key index, water-fill the per-region cap."""
    index = empty_key_index()
    pool_counts: Counter[str] = Counter()
    dropped: Counter[str] = Counter()
    board_count = scanned = 0
    for row in iter_label_rows(juso_zip, args.max_rows_per_region):
        reason = eligible(row, args.max_field_chars)
        if reason:
            dropped[reason] += 1
            continue
        scanned += 1
        index_label_row(index, row)
        if muni_bucket(unit_key(row.region, row.sigungu)) >= args.board_bucket_min:
            board_count += 1
        else:
            pool_counts[row.region] += 1
    alias_key_index(index)
    print(f"pass 1: {scanned:,} eligible register rows · {len(pool_counts)} regions · board pool {board_count:,}")
    print(
        f"pass 1: dropped {dict(dropped)} · key index {len(index.regions)} regions, {sum(len(v) for v in index.roads_by_unit.values()):,} (unit, road) keys"
    )
    drop_rate = sum(dropped.values()) / max(scanned + sum(dropped.values()), 1)
    if drop_rate > 0.02:
        raise RuntimeError(
            f"register drop rate {drop_rate:.4f} exceeds 2% — the eligibility filter no longer fits the data"
        )

    target = args.train_rows + args.val_rows
    cap = water_fill(pool_counts, target)
    quotas = {region: min(cap, count) for region, count in pool_counts.items()}
    shortfall = target - sum(quotas.values())
    if shortfall > 0:
        for region in sorted(pool_counts, key=lambda r: pool_counts[r] - quotas[r], reverse=True):
            grant = min(pool_counts[region] - quotas[region], shortfall)
            quotas[region] += grant
            shortfall -= grant
            if shortfall <= 0:
                break
    print(f"pass 1: per-region cap {cap:,}; quota total {sum(quotas.values()):,} of target {target:,}")
    return RegisterSurvey(index, scanned, dropped, pool_counts, board_count, cap, quotas)


def survey_permits(permit_dir: Path, args: argparse.Namespace, index: KeyIndex) -> PermitSurvey:
    """Pass 2: measure alignment per form and per category, and average each 시군구's permit points.

    The census is written to the build report BEFORE any row is selected, so the alignment rate is a
    measurement of the source rather than of what survived selection.
    """
    survey = PermitSurvey()
    centroid_sums: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])
    points: list[tuple[float, float]] = []
    units: list[str] = []

    def flush_points() -> None:
        for point, key in zip(registers.transform_coordinates(points), units, strict=True):
            if point is None:
                continue
            sums = centroid_sums[key]
            sums[0] += point[0]
            sums[1] += point[1]
            sums[2] += 1
        points.clear()
        units.clear()

    for permit in registers.iter_permit_rows(permit_dir, pattern=args.permit_glob):
        bucket = survey.census_category.setdefault(permit.category, Counter())
        aligned = permit_alignment(permit, index)
        forms = {"road": permit.road_address, "lot": permit.lot_address}
        by_register = {item.register: item for item in aligned}
        for form, text in forms.items():
            key = "empty" if not text else ("aligned" if f"registry_{form}" in by_register else "unaligned")
            survey.census_form[f"{form}_{key}"] += 1
            bucket[f"{form}_{key}"] += 1
        if aligned:
            unit = unit_key(aligned[0].region, aligned[0].sigungu)
            if permit.x is not None and permit.y is not None:
                points.append((permit.x, permit.y))
                units.append(unit)
                if len(points) >= PROJECTION_BATCH:
                    flush_points()
            if muni_bucket(unit) >= args.board_bucket_min:
                survey.registry_board_pool += len(aligned)
            else:
                survey.registry_pool += len(aligned)
        elif permit.road_address or permit.lot_address:
            survey.unaligned_pool += 1
    flush_points()
    survey.centroids = {key: [s[0] / s[2], s[1] / s[2]] for key, s in centroid_sums.items() if s[2]}
    print(
        f"pass 2: permits aligned — {dict(survey.census_form)} · registry pool {survey.registry_pool:,} · held-out {survey.registry_board_pool:,} · unaligned {survey.unaligned_pool:,} · centroids {len(survey.centroids)}"
    )
    return survey
