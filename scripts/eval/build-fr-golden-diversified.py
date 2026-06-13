#!/usr/bin/env python3
# @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
#
# Build ~150 diversified FR golden DEV rows sourced from real OA FR addresses.
# Addresses come from fr/countrywide.csv inside /tmp/oa-cache/fr__countrywide.zip
# (OpenAddresses data, https://openaddresses.io).
#
# Each OA record provides NUMBER + STREET + POSTCODE + CITY — all from a real
# authoritative address registry (BAN: Base Adresse Nationale). We do NOT
# hand-invent streets or postcodes; we only choose the rendering ORDER.
#
# Three canonical FR address orders are exercised:
#   canonical  : "NN Street, PPPPP City"            (BAN / official mail order)
#   pc-first   : "PPPPP City, NN Street"            (reversed — common in forms)
#   city-pc-nn : "City, PPPPP, NN Street"           (locality-first envelope style)
#
# The street field in OA is already the full street name (e.g. "Rue de la Paix"),
# so components.street holds the full OA STREET value — matching the pattern used
# in the existing Sainte-Livrade BAN rows (not the hand-split prefix/particle form).
#
# Usage:
#   python scripts/eval/build-fr-golden-diversified.py
# writes data/eval/golden/v0.1.2/dev/fr-diversified.jsonl (preview)
# then you manually merge into fr.jsonl
#
# Or: python scripts/eval/build-fr-golden-diversified.py --inplace
#   appends directly to data/eval/golden/v0.1.2/dev/fr.jsonl

import csv
import io
import json
import random
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

OA_ZIP = Path("/tmp/oa-cache/fr__countrywide.zip")
OA_ENTRY = "fr/countrywide.csv"
OUT_FILE = Path("data/eval/golden/v0.1.2/dev/fr-diversified.jsonl")
GOLDEN_FILE = Path("data/eval/golden/v0.1.2/dev/fr.jsonl")

# How many source cities to sample from
TARGET_ROWS = 150
CITIES_PER_BATCH = 50   # sample from this many distinct cities
ROWS_PER_CITY = 3       # max OA rows to use per city

# Seed for reproducibility
RNG_SEED = 466

# Prefer these well-known cities (will always be included if found)
PREFERRED_CITIES = {
    "Paris", "Marseille", "Lyon", "Toulouse", "Bordeaux", "Nantes",
    "Strasbourg", "Montpellier", "Rennes", "Reims", "Le Havre",
    "Grenoble", "Dijon", "Angers", "Nîmes", "Toulon",
    "Clermont-Ferrand", "Amiens", "Limoges", "Perpignan", "Brest",
    "Caen", "Metz", "Nancy", "Orléans", "Rouen", "Mulhouse",
    "Dunkerque", "Avignon", "Nice", "Versailles",
}

# These are the three rendering orders
ORDERS = ["canonical", "pc-first", "city-pc-nn"]


def load_oa_samples(seed: int) -> dict[str, list[dict]]:
    """Read OA zip and collect up to ROWS_PER_CITY samples per city."""
    rng = random.Random(seed)
    city_pool: dict[str, list[dict]] = defaultdict(list)

    print(f"Opening {OA_ZIP} ...", file=sys.stderr)
    with zipfile.ZipFile(OA_ZIP) as zf:
        with zf.open(OA_ENTRY) as raw:
            # The file is large (~2.5 GB); stream with csv.reader
            reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8"))
            scanned = 0
            for row in reader:
                city = row.get("CITY", "").strip()
                num = row.get("NUMBER", "").strip()
                street = row.get("STREET", "").strip()
                postcode = row.get("POSTCODE", "").strip()

                # Basic quality filters
                if not (city and num and street and postcode):
                    continue
                if len(postcode) != 5 or not postcode.isdigit():
                    continue
                # Skip numbers like "5000" (no-geometry placeholder in BAN)
                try:
                    n = int(num.rstrip("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"))
                    if n >= 5000:
                        continue
                except ValueError:
                    continue

                city_pool[city].append({
                    "number": num,
                    "street": street,
                    "postcode": postcode,
                    "city": city,
                })

                scanned += 1
                if scanned % 5_000_000 == 0:
                    print(f"  scanned {scanned:,} rows, {len(city_pool):,} cities so far", file=sys.stderr)
                # Stop after 20M rows — enough to cover all of France
                if scanned >= 20_000_000:
                    break

    print(f"Done: {scanned:,} rows, {len(city_pool):,} distinct cities", file=sys.stderr)
    return city_pool


def select_cities(city_pool: dict[str, list[dict]], rng: random.Random) -> list[str]:
    """Pick CITIES_PER_BATCH cities: preferred first, then random others."""
    found_preferred = [c for c in PREFERRED_CITIES if c in city_pool]
    remaining = [c for c in city_pool if c not in PREFERRED_CITIES]
    rng.shuffle(remaining)
    # Combine: prefer famous cities but cap total at CITIES_PER_BATCH
    selected = found_preferred + remaining
    return selected[:CITIES_PER_BATCH]


def make_row(num: str, street: str, postcode: str, city: str, order: str) -> dict:
    """Render one address row in the given order."""
    components: dict[str, str] = {
        "house_number": num,
        "street": street,
        "postcode": postcode,
        "locality": city,
    }

    if order == "canonical":
        # "NN Street, PPPPP City"
        raw = f"{num} {street}, {postcode} {city}"
        note = "FR canonical order: house_number street, postcode locality (OA/BAN source)"
    elif order == "pc-first":
        # "PPPPP City, NN Street"
        raw = f"{postcode} {city}, {num} {street}"
        note = "FR reversed order: postcode locality, house_number street (common in forms)"
    elif order == "city-pc-nn":
        # "City, PPPPP, NN Street"
        raw = f"{city}, {postcode}, {num} {street}"
        note = "FR locality-first style: locality, postcode, house_number street"
    else:
        raise ValueError(f"Unknown order: {order}")

    return {
        "raw": raw,
        "components": components,
        "country": "FR",
        "source": "golden",
        "notes": note,
    }


def build_rows(city_pool: dict[str, list[dict]], rng: random.Random) -> list[dict]:
    cities = select_cities(city_pool, rng)
    rows: list[dict] = []

    for city in cities:
        candidates = city_pool[city]
        # Pick up to ROWS_PER_CITY distinct OA addresses
        sample_size = min(ROWS_PER_CITY, len(candidates))
        sampled = rng.sample(candidates, sample_size)

        for i, addr in enumerate(sampled):
            # Cycle through orders so every city covers at least one distinct order
            order = ORDERS[i % len(ORDERS)]
            rows.append(make_row(
                num=addr["number"],
                street=addr["street"],
                postcode=addr["postcode"],
                city=addr["city"],
                order=order,
            ))

        if len(rows) >= TARGET_ROWS:
            break

    # Trim to target
    return rows[:TARGET_ROWS]


def report_distribution(rows: list[dict]) -> None:
    locality_counts: dict[str, int] = defaultdict(int)
    order_counts: dict[str, int] = defaultdict(int)

    for r in rows:
        loc = r["components"].get("locality", "?")
        locality_counts[loc] += 1
        # Determine order from notes
        note = r.get("notes", "")
        if "canonical" in note:
            order_counts["canonical"] += 1
        elif "reversed" in note:
            order_counts["pc-first"] += 1
        elif "locality-first" in note:
            order_counts["city-pc-nn"] += 1

    print(f"\n=== Distribution report ({len(rows)} new rows) ===")
    print(f"\nOrder mix:")
    for order, count in sorted(order_counts.items(), key=lambda x: -x[1]):
        print(f"  {order}: {count}")

    print(f"\nTop localities (by count):")
    for loc, count in sorted(locality_counts.items(), key=lambda x: -x[1])[:20]:
        print(f"  {loc}: {count}")

    print(f"\nDistinct localities: {len(locality_counts)}")


def main() -> None:
    inplace = "--inplace" in sys.argv

    rng = random.Random(RNG_SEED)
    city_pool = load_oa_samples(RNG_SEED)
    rows = build_rows(city_pool, rng)

    report_distribution(rows)

    if inplace:
        dest = GOLDEN_FILE
        mode = "a"
        print(f"\nAppending {len(rows)} rows to {dest} ...", file=sys.stderr)
    else:
        dest = OUT_FILE
        mode = "w"
        print(f"\nWriting {len(rows)} rows to {dest} ...", file=sys.stderr)

    dest.parent.mkdir(parents=True, exist_ok=True)
    with open(dest, mode, encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    print("Done.", file=sys.stderr)

    # Validate JSON parse of every written line
    if not inplace:
        with open(dest, encoding="utf-8") as f:
            for i, line in enumerate(f, 1):
                try:
                    json.loads(line)
                except json.JSONDecodeError as e:
                    print(f"JSON parse error at line {i}: {e}", file=sys.stderr)
                    sys.exit(1)
        print(f"All {len(rows)} lines parse clean.", file=sys.stderr)


if __name__ == "__main__":
    main()
