#!/usr/bin/env python3
# @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
#
# Build a representative, COORDINATE-BEARING held-out eval set for a non-US locale
# from a standard-schema OpenAddresses country dump (#229 Phase A).
#
# Why this exists: the existing per-locale golden measures non-US labels thinly and
# unrepresentatively (the FR `region` rows, e.g., are synthetic multi-script + order
# permutations — see 2026-06-22-fr-eval-coverage-scorecard.md). Label-F1 on non-US is
# also confounded by labeling conventions (a Spanish "Calle Mayor" street boundary).
# The honest metric is the ASSEMBLED COORDINATE — so this builds rows that carry the
# truth lat/lon, graded by scripts/eval/fr-admin-split-gate.ts --default-country <CC>
# (parse -> resolve -> great-circle error), the metric we ship.
#
# Source: a standard-schema OA countrywide CSV with LON,LAT,NUMBER,STREET,CITY,
# POSTCODE[,REGION] columns (IT/FR/most OA collections). The Spanish dump uses a
# different cadastral schema and is NOT handled here (label-only spot-check instead).
#
# Sampling: bucket by REGION (or postcode prefix when REGION is absent) and cap per
# bucket, so the set spans the whole country, not the first province on disk. Render
# in three natural orders (canonical / postcode-first / locality-first) so the model
# isn't graded on one rigid template. Streams the CSV (csv.DictReader) — OOM-safe on
# the multi-GB dumps.
#
# Usage:
#   python scripts/eval/build-oa-coord-golden.py --country IT \
#     --zip /mnt/playpen/mailwoman-data/oa-cache/it__countrywide.zip \
#     --entry it/countrywide.csv --out data/eval/external/oa-it-coord-150.jsonl --n 150

import argparse
import csv
import io
import json
import random
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

ORDERS = ["canonical", "pc-first", "city-first"]


def render(street: str, num: str, cp: str, city: str, order: str) -> str:
    if order == "canonical":
        return f"{street} {num}, {cp} {city}"
    if order == "pc-first":
        return f"{cp} {city}, {street} {num}"
    return f"{city}, {cp}, {street} {num}"


def titlecase_if_upper(s: str) -> str:
    return s.title() if s.isupper() else s


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--country", required=True, help="ISO-3166 alpha-2, e.g. IT")
    ap.add_argument("--zip", required=True)
    ap.add_argument("--entry", required=True, help="the .csv path inside the zip")
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=150)
    ap.add_argument("--per-bucket", type=int, default=8)
    ap.add_argument("--seed", type=int, default=722)
    a = ap.parse_args()

    rng = random.Random(a.seed)
    buckets: dict[str, list] = defaultdict(list)
    with zipfile.ZipFile(a.zip) as z, z.open(a.entry) as f:
        reader = csv.DictReader(io.TextIOWrapper(f, "utf-8"))
        for row in reader:
            num = (row.get("NUMBER") or "").strip()
            street = (row.get("STREET") or "").strip()
            city = (row.get("CITY") or "").strip()
            cp = (row.get("POSTCODE") or "").strip()
            region = (row.get("REGION") or "").strip()
            try:
                lat = float(row.get("LAT", ""))
                lon = float(row.get("LON", ""))
            except ValueError:
                continue
            if not (num and street and city and cp and num != "0" and street[:1].isalpha()):
                continue
            key = region or cp[:2]  # geographic diversity bucket
            if len(buckets[key]) < a.per_bucket:
                buckets[key].append(
                    {
                        "street": titlecase_if_upper(street),
                        "num": num,
                        "cp": cp,
                        "city": titlecase_if_upper(city),
                        "lat": lat,
                        "lon": lon,
                    }
                )
            if sum(len(v) for v in buckets.values()) >= a.n * 2:
                break

    rows = []
    i = 0
    for key in sorted(buckets):
        for r in buckets[key]:
            order = ORDERS[i % 3]
            i += 1
            rows.append(
                {
                    "raw": render(r["street"], r["num"], r["cp"], r["city"], order),
                    "components": {"house_number": r["num"], "street": r["street"], "postcode": r["cp"], "locality": r["city"]},
                    "country": a.country.upper(),
                    "lat": r["lat"],
                    "lon": r["lon"],
                    "source": "golden",
                }
            )
    rng.shuffle(rows)
    rows = rows[: a.n]

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"wrote {len(rows)} {a.country.upper()} rows across {len(buckets)} buckets -> {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
