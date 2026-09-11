"""Count what a row's OPENING token teaches, at both the draw level and the emitted level.

WHY THIS EXISTS. A claim that one reading of an opening outweighs another is a claim about counts, and a
count is only comparable when its definition and its sampling level travel with it. A figure of 443.7
rows per pass was carried through three documents with neither, which is what this module replaces: it
counts both readings under definitions stated here, at both levels, so the comparison rests on stated
terms rather than a remembered convention.

WHAT IT FOUND, and why the narrow definitions matter. Reading "that opening" more or less narrowly does
not shade the answer, it REVERSES it. Over 1,000,000 emitted rows of the v5.6.0 mixture:

    opening                            house_number   postcode
    any digit group                         249,934     93,665   2.67:1 toward house_number
    exactly three digits                     53,451     18,140   2.95:1 toward house_number
    three then two digits                       273     18,140     66:1 toward POSTCODE
    the same, as a COMPLETE two-token row          0        508   no contrary evidence at all

So an opening-level ratio cannot explain why `100 00` reads as a house number: at that exact opening the
mixture already favours postcode 66 to 1. 17,632 of those 18,140 rows are in-context surfaces like
`100 00 Praha, Czechia`, which do not transfer to the bare input. What separates the two is that the
failing row ENDS after two tokens — hence the whole-row counters, which is the count that moved from
zero.

BOTH LEVELS, BECAUSE THEY DISAGREE. Pass 1 counts rows straight off the sampler. Pass 2 expands the same
stream through the augmentation policy and counts what fills the trainer's row budget, which is what the
model reads. Augmentation expands long addresses, so a short-row source keeps a smaller part of a fixed
budget and the two levels differ by more than 20% for one — a ratio mixing them is meaningless.

The sampling mirrors `audit_epoch_mixture` exactly — same stream, same seed convention, same budget — so
a count here is comparable with an exposure reported there. The one deliberate difference is
`augment_exclude_sources`, which that module does not apply and the trainer does.
"""

from __future__ import annotations

import argparse
import json
import random
from collections.abc import Iterator
from itertools import islice
from pathlib import Path
from typing import Any

from .augment import augment_row
from .config import load_config
from .data_loader import _raw_row_stream
from .dose import resolve_config_doses


def _digits(token: str) -> bool:
    return token.isdigit()


def _opening_counts(tokens: list[str], labels: list[str]) -> list[str]:
    """Name every opening the row matches. A row can match more than one — they are nested, not rival."""
    if not tokens or not labels:
        return []

    first, label = tokens[0], labels[0]
    if not _digits(first):
        return []

    three_then_two = len(tokens) >= 2 and len(first) == 3 and _digits(tokens[1]) and len(tokens[1]) == 2

    # A row of EXACTLY two tokens is the shape the failing input has and the corpus never carried: the
    # opening is shared with every in-context row that starts on its postcode, so an opening count alone
    # cannot separate `100 00` from `100 00 Praha, Czechia`. Row length is what separates them.
    whole_row = len(tokens) == 2

    if label == "B-house_number":
        names = ["any_digits_house"]
        if len(first) == 3:
            names.append("three_digits_house")
        if three_then_two:
            names.append("nnn_nn_house")
            if whole_row:
                names.append("nnn_nn_house_whole_row")
        return names

    if label == "B-postcode":
        names = ["any_digits_postcode"]
        if len(first) == 3:
            names.append("three_digits_postcode")
        if three_then_two:
            names.append("nnn_nn_postcode")
            if whole_row:
                names.append("nnn_nn_postcode_whole_row")
        return names

    return []


NAMES = (
    "any_digits_house",
    "three_digits_house",
    "nnn_nn_house",
    "nnn_nn_house_whole_row",
    "any_digits_postcode",
    "three_digits_postcode",
    "nnn_nn_postcode",
    "nnn_nn_postcode_whole_row",
)


def census(
    corpus_dir: Path,
    *,
    seed: int,
    draws: int,
    country_weights: dict[str, float],
    source_weights: dict[str, float] | None,
    coarse_filter: bool,
    augment: dict[str, float],
    augment_exclude_sources: tuple[str, ...] = (),
) -> dict[str, Any]:
    """Count every opening over ``draws`` rows, at the draw level and again at the emitted level.

    ``augment_exclude_sources`` is honoured here because the TRAINER honours it (`data_loader._emit`):
    a listed source bypasses augmentation entirely, so it emits exactly what it drew while its
    neighbours expand. `audit_epoch_mixture` does not apply it, which is why an excluded source's
    emitted count differs between that report and this one — this one is the trainer's behaviour.
    """

    def stream(rng: random.Random) -> Iterator[dict[str, Any]]:
        return _raw_row_stream(
            Path(corpus_dir),
            "train",
            rng=rng,
            country_weights=country_weights,
            source_weights=source_weights,
            coarse_filter=coarse_filter,
        )

    drawn = dict.fromkeys(NAMES, 0)
    drawn_by_source: dict[str, dict[str, int]] = {}
    total_drawn = 0
    for row in islice(stream(random.Random(seed)), draws):
        total_drawn += 1
        names = _opening_counts(row.get("tokens") or [], row.get("labels") or [])
        for name in names:
            drawn[name] += 1
            per = drawn_by_source.setdefault(row["source"], dict.fromkeys(NAMES, 0))
            per[name] += 1

    rng2 = random.Random(seed)
    do_augment = any(p > 0 for p in augment.values())
    excluded = frozenset(augment_exclude_sources)
    emitted_counts = dict.fromkeys(NAMES, 0)
    emitted_by_source: dict[str, dict[str, int]] = {}
    emitted = 0
    for row in stream(rng2):
        if emitted >= draws:
            break
        outs = (
            list(
                augment_row(
                    row,
                    rng2,
                    directional_prob=augment["directional"],
                    region_prob=augment["region"],
                    glue_prob=augment["glue"],
                    case_prob=augment["case"],
                    punct_drop_prob=augment["punct_drop"],
                    upper_case_prob=augment["upper_case"],
                    ordinal_prob=augment["ordinal"],
                )
            )
            if do_augment and row["source"] not in excluded
            else [row]
        )
        for out in outs:
            if emitted >= draws:
                break
            emitted += 1
            for name in _opening_counts(out.get("tokens") or [], out.get("labels") or []):
                emitted_counts[name] += 1
                per = emitted_by_source.setdefault(out["source"], dict.fromkeys(NAMES, 0))
                per[name] += 1

    def ratio(house: str, postcode: str, counts: dict[str, int]) -> float | None:
        return (counts[house] / counts[postcode]) if counts[postcode] else None

    return {
        "meta": {
            "seed": seed,
            "draws_requested": draws,
            "rows_drawn": total_drawn,
            "rows_emitted": emitted,
            "corpus_dir": str(corpus_dir),
        },
        "draw_level": {
            "counts": drawn,
            "house_over_postcode": {
                "any_digits": ratio("any_digits_house", "any_digits_postcode", drawn),
                "three_digits": ratio("three_digits_house", "three_digits_postcode", drawn),
                "nnn_nn": ratio("nnn_nn_house", "nnn_nn_postcode", drawn),
                "nnn_nn_whole_row": ratio("nnn_nn_house_whole_row", "nnn_nn_postcode_whole_row", drawn),
            },
            "by_source": {s: c for s, c in sorted(drawn_by_source.items())},
        },
        "emitted_level": {
            "counts": emitted_counts,
            "house_over_postcode": {
                "any_digits": ratio("any_digits_house", "any_digits_postcode", emitted_counts),
                "three_digits": ratio("three_digits_house", "three_digits_postcode", emitted_counts),
                "nnn_nn": ratio("nnn_nn_house", "nnn_nn_postcode", emitted_counts),
                "nnn_nn_whole_row": ratio("nnn_nn_house_whole_row", "nnn_nn_postcode_whole_row", emitted_counts),
            },
            "by_source": {s: c for s, c in sorted(emitted_by_source.items())},
        },
    }


def run(config_path: Path, *, json_path: Path | None = None, draws: int | None = None) -> dict[str, Any]:
    """Load a training config, count both levels over one epoch, print the table and return the report."""
    cfg = load_config(config_path)
    corpus_dir = Path(cfg.data.corpus_dir)
    resolve_config_doses(cfg, corpus_dir)

    report = census(
        corpus_dir,
        seed=cfg.train.seed + 1,
        draws=draws or cfg.data.train_rows_per_epoch,
        country_weights=cfg.data.country_weights,
        source_weights=cfg.data.source_weights,
        coarse_filter=cfg.data.coarse_filter,
        augment={
            "directional": cfg.data.augment_directional_prob,
            "region": cfg.data.augment_region_prob,
            "glue": cfg.data.augment_glue_prob,
            "case": getattr(cfg.data, "augment_case_prob", 0.0),
            "punct_drop": cfg.data.augment_punct_drop_prob,
            "upper_case": getattr(cfg.data, "augment_upper_case_prob", 0.0),
            "ordinal": cfg.data.augment_ordinal_prob,
        },
        augment_exclude_sources=tuple(getattr(cfg.data, "augment_exclude_sources", ()) or ()),
    )

    meta = report["meta"]
    print(f"opening-token census — {config_path.name}")
    print(f"  seed {meta['seed']}, {meta['rows_drawn']:,} rows drawn, {meta['rows_emitted']:,} rows emitted\n")
    print(f"  {'opening':24s} {'drawn':>12s} {'emitted':>12s}")
    for name in NAMES:
        print(
            f"  {name:24s} {report['draw_level']['counts'][name]:>12,} {report['emitted_level']['counts'][name]:>12,}"
        )
    print("\n  house-over-postcode ratio at each opening:")
    for key in ("any_digits", "three_digits", "nnn_nn", "nnn_nn_whole_row"):
        d = report["draw_level"]["house_over_postcode"][key]
        e = report["emitted_level"]["house_over_postcode"][key]
        print(
            f"    {key:14s} drawn {('none' if d is None else f'{d:.2f}:1'):>10s}   emitted {('none' if e is None else f'{e:.2f}:1'):>10s}"
        )

    if json_path is not None:
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"\nwrote {json_path}")

    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("--json", type=Path, default=None)
    parser.add_argument("--draws", type=int, default=None)
    args = parser.parse_args()
    run(args.config, json_path=args.json, draws=args.draws)


if __name__ == "__main__":
    main()
