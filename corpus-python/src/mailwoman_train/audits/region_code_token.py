"""Count what a two-letter uppercase token teaches: a country, or a region.

WHY THIS EXISTS. `Swiss Chalet, 92 Laurel Rd, Gander, NL A1V 0A9, Canada` answers `country: NL` — the
Netherlands — with `Canada` written in full at the end of the same string (#2299). `NL` is a Canadian
province code and an ISO alpha-2 country code, and the model reads whichever one the corpus attested
more. A claim that one reading outweighs the other is a claim about counts, so this module counts them,
at the definitions stated here and at both sampling levels.

NO CODE LIST IS TYPED HERE. Every two-letter uppercase token is counted and keyed by itself, so the
contested set falls out of the data rather than out of a table that would be a second copy of the
codex's. A code with a count under one tag only is not contested. a code with counts under both is.

BOTH LEVELS, BECAUSE AUGMENTATION WRITES REGIONS. `augment_region_prob` appends a region surface to a
row that did not carry one, so the emitted stream carries region codes the drawn stream does not. A
count taken at the draw level alone understates the region side by exactly the augmentation's share,
which is the error this module exists to avoid rather than commit. The sampling mirrors
`audit_epoch_mixture` and `census_opening_token` — same stream, same seed convention, same budget — so
a count here is comparable with an exposure reported there.
"""

from __future__ import annotations

import argparse
import json
import random
from collections.abc import Iterable, Iterator
from itertools import islice
from pathlib import Path
from typing import Any

from ..config import load_config
from ..data.emit import EmitPolicy, emit_row
from ..data.loader import _raw_row_stream
from ..data.source_reps import resolve_config_reps


def code_shaped(token: str) -> bool:
    """True for a token an address line could be writing as a subdivision or country code."""
    return len(token) == 2 and token.isascii() and token.isupper() and token.isalpha()


def _tag(label: str) -> str | None:
    """The tag a token OPENS, or None.

    Only a `B-` label counts. A two-letter token inside a longer span is part of a name rather than a
    code the row attests on its own, and counting it would credit `St. John's, NL` and `Newfoundland
    and Labrador` to the same evidence.
    """
    return label[2:] if label.startswith("B-") else None


def audit_rows(rows: Iterable[dict[str, Any]]) -> dict[str, dict[str, int]]:
    """Count every code-shaped token by the tag it opens, keyed by the token itself."""
    counts: dict[str, dict[str, int]] = {}

    for row in rows:
        tokens = row.get("tokens") or []
        labels = row.get("labels") or []

        for token, label in zip(tokens, labels, strict=False):
            if not code_shaped(token):
                continue

            tag = _tag(label)

            if tag is None:
                continue

            counts.setdefault(token, {})
            counts[token][tag] = counts[token].get(tag, 0) + 1

    return counts


def contested(counts: dict[str, dict[str, int]]) -> list[tuple[str, int, int]]:
    """Codes carrying both readings, worst first — `(code, country, region)`, ordered by the region deficit."""
    rows = [
        (code, tags.get("country", 0), tags.get("region", 0))
        for code, tags in counts.items()
        if tags.get("country", 0) and tags.get("region", 0)
    ]

    return sorted(rows, key=lambda row: row[1] / max(row[2], 1), reverse=True)


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
    """Count code-shaped tokens over ``draws`` rows, at the draw level and again at the emitted level."""

    def stream(rng: random.Random) -> Iterator[dict[str, Any]]:
        return _raw_row_stream(
            Path(corpus_dir),
            "train",
            rng=rng,
            country_weights=country_weights,
            source_weights=source_weights,
            coarse_filter=coarse_filter,
        )

    drawn_rows = list(islice(stream(random.Random(seed)), draws))
    drawn = audit_rows(drawn_rows)

    rng2 = random.Random(seed)
    policy = EmitPolicy(
        directional_prob=augment["directional"],
        region_prob=augment["region"],
        glue_prob=augment["glue"],
        case_prob=augment["case"],
        punct_drop_prob=augment["punct_drop"],
        upper_case_prob=augment["upper_case"],
        ordinal_prob=augment["ordinal"],
        excluded_sources=frozenset(augment_exclude_sources),
    )

    def emitted_stream() -> Iterator[dict[str, Any]]:
        produced = 0

        for row in stream(rng2):
            for out in emit_row(row, rng2, policy):
                if produced >= draws:
                    return

                produced += 1

                yield out

    emitted = audit_rows(emitted_stream())

    return {
        "meta": {
            "seed": seed,
            "draws_requested": draws,
            "rows_drawn": len(drawn_rows),
            "corpus_dir": str(corpus_dir),
        },
        "draw_level": {"counts": drawn, "contested": contested(drawn)},
        "emitted_level": {"counts": emitted, "contested": contested(emitted)},
    }


def run(config_path: Path, *, json_path: Path | None = None, draws: int | None = None) -> dict[str, Any]:
    """Load a training config, count both levels over one epoch, print the contested table, return the report."""
    cfg = load_config(config_path)
    corpus_dir = Path(cfg.data.corpus_dir)
    resolve_config_reps(cfg, corpus_dir)

    epoch_rows = draws or getattr(cfg.data, "train_rows_per_epoch", None)

    if not epoch_rows:
        raise ValueError("config has no train_rows_per_epoch — pass --draws for the epoch length")

    report = census(
        corpus_dir,
        seed=cfg.train.seed + 1,
        draws=int(epoch_rows),
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
    print(f"region-code token census — {config_path.name}")
    print(f"  seed {meta['seed']}, {meta['rows_drawn']:,} rows drawn\n")

    for level in ("draw_level", "emitted_level"):
        print(f"  {level.replace('_', ' ')} — codes carrying BOTH readings:")
        print(f"    {'code':>6s} {'country':>12s} {'region':>12s} {'ratio':>10s}")

        for code, country, region in report[level]["contested"]:
            print(f"    {code:>6s} {country:>12,} {region:>12,} {country / max(region, 1):>9.1f}:1")

        print()

    if json_path is not None:
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"wrote {json_path}")

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
