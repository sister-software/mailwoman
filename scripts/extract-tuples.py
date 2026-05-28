#!/usr/bin/env python3
"""Extract (locality, region, postcode, country) tuples from existing parquet corpus shards.

Reads a parquet shard, scans the BIO labels for rows that have at least
(locality + region + postcode), reconstructs the component spans from
tokens+labels, and writes a JSONL file with one tuple per output line.
Also emits street + houseNumber if present (used for PMB synthesis).

Usage:
  python3 scripts/extract-tuples.py \\
    --shards /mnt/playpen/mailwoman-data/wof/admin-global-priority.db \\
    --output /tmp/tuples.jsonl \\
    [--limit 50000]
"""

import argparse
import json
import sys
from pathlib import Path


def extract_from_parquet(shard_path: Path, output_handle, limit: int | None) -> int:
    """Pull (locality, region, postcode, country, [street, houseNumber]) from a parquet shard."""
    import pyarrow.parquet as pq

    t = pq.read_table(str(shard_path))
    cols = {name: t[name].to_pylist() for name in ["raw", "tokens", "labels", "country"]}
    emitted = 0

    for i in range(t.num_rows):
        if limit is not None and emitted >= limit:
            break
        tokens = cols["tokens"][i]
        labels = cols["labels"][i]
        country = cols["country"][i]
        if not tokens or not labels:
            continue

        # Group tokens by component tag (B-tag starts new span; I-tag continues).
        components: dict[str, list[str]] = {}
        current_tag: str | None = None
        for tok, lab in zip(tokens, labels):
            if lab == "O":
                current_tag = None
                continue
            prefix, _, tag = lab.partition("-")
            if prefix == "B" or tag != current_tag:
                if tag not in components:
                    components[tag] = []
                components[tag].append(tok)
                current_tag = tag
            else:
                components[tag][-1] += " " + tok
                current_tag = tag

        # Need at least locality + region + postcode.
        loc = components.get("locality", [None])[0] if "locality" in components else None
        reg = components.get("region", [None])[0] if "region" in components else None
        pc = components.get("postcode", [None])[0] if "postcode" in components else None
        if not (loc and reg and pc):
            continue

        # Drop any rows whose postcode is bogus (test-data hallucinations).
        if len(pc) < 3 or not any(c.isdigit() or c.isalpha() for c in pc):
            continue

        tuple_out = {
            "locality": loc,
            "region": reg,
            "postcode": pc,
            "country": country or "US",
        }
        street = components.get("street", [None])[0]
        hn = components.get("house_number", [None])[0]
        if street:
            tuple_out["street"] = street
        if hn:
            tuple_out["houseNumber"] = hn

        output_handle.write(json.dumps(tuple_out, ensure_ascii=False) + "\n")
        emitted += 1

    return emitted


def extract_from_sqlite(db_path: Path, output_handle, limit: int | None) -> int:
    """Pull tuples directly from the WOF SQLite admin DB.

    For US: pair localities with sampled US postcodes (we don't have the postalcode WOF repo
    locally yet). For now, synthesize plausible 5-digit postcodes from the parent state's
    known ZIP range. This is acceptable because the model trains on the SHAPE, not on
    geocoder-correctness of locality↔postcode pairs.
    """
    import sqlite3

    # State ZIP code first-digit ranges. Approximate, not exhaustive.
    STATE_ZIP_PREFIXES = {
        "AL": (350, 369), "AK": (995, 999), "AZ": (850, 865), "AR": (716, 729),
        "CA": (900, 961), "CO": (800, 816), "CT": (60, 69), "DE": (197, 199),
        "FL": (320, 349), "GA": (300, 319), "HI": (967, 968), "ID": (832, 838),
        "IL": (600, 629), "IN": (460, 479), "IA": (500, 528), "KS": (660, 679),
        "KY": (400, 427), "LA": (700, 714), "ME": (39, 49), "MD": (206, 219),
        "MA": (10, 27), "MI": (480, 499), "MN": (550, 567), "MS": (386, 397),
        "MO": (630, 658), "MT": (590, 599), "NE": (680, 693), "NV": (889, 898),
        "NH": (30, 38), "NJ": (70, 89), "NM": (870, 884), "NY": (100, 149),
        "NC": (270, 289), "ND": (580, 588), "OH": (430, 458), "OK": (730, 749),
        "OR": (970, 979), "PA": (150, 196), "RI": (28, 29), "SC": (290, 299),
        "SD": (570, 577), "TN": (370, 385), "TX": (750, 799), "UT": (840, 847),
        "VT": (50, 59), "VA": (220, 246), "WA": (980, 994), "WV": (247, 268),
        "WI": (530, 549), "WY": (820, 831), "DC": (200, 205),
    }

    import random
    random.seed(42)

    conn = sqlite3.connect(str(db_path))
    cur = conn.cursor()

    # Get US localities with their grandparent region. WOF hierarchy is
    # locality → county → region → country.
    cur.execute("""
        SELECT s.name as locality, r.name as region_name
        FROM spr s
        JOIN spr c ON s.parent_id = c.id AND c.placetype = 'county'
        JOIN spr r ON c.parent_id = r.id AND r.placetype = 'region'
        WHERE s.country = 'US' AND s.placetype = 'locality' AND s.is_current = 1
        ORDER BY RANDOM()
        LIMIT ?
    """, (limit if limit is not None else 100000,))

    emitted = 0
    for locality, region_name in cur:
        if not locality or not region_name:
            continue
        # Best-effort: convert "California" → "CA" via STATE_ZIP_PREFIXES key match.
        # If region_name is already an abbrev (rare), use as-is.
        abbr = None
        if len(region_name) == 2 and region_name.upper() in STATE_ZIP_PREFIXES:
            abbr = region_name.upper()
        else:
            # Try a coarse name → abbr lookup. Skip if unknown.
            from_name = {
                "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR",
                "California": "CA", "Colorado": "CO", "Connecticut": "CT",
                "Delaware": "DE", "Florida": "FL", "Georgia": "GA", "Hawaii": "HI",
                "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA",
                "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME",
                "Maryland": "MD", "Massachusetts": "MA", "Michigan": "MI",
                "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO",
                "Montana": "MT", "Nebraska": "NE", "Nevada": "NV",
                "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM",
                "New York": "NY", "North Carolina": "NC", "North Dakota": "ND",
                "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA",
                "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD",
                "Tennessee": "TN", "Texas": "TX", "Utah": "UT", "Vermont": "VT",
                "Virginia": "VA", "Washington": "WA", "West Virginia": "WV",
                "Wisconsin": "WI", "Wyoming": "WY",
                "District of Columbia": "DC",
            }
            abbr = from_name.get(region_name)
        if not abbr or abbr not in STATE_ZIP_PREFIXES:
            continue

        lo, hi = STATE_ZIP_PREFIXES[abbr]
        # Random 5-digit ZIP within the state's range.
        prefix = lo + int(random.random() * (hi - lo + 1))
        zip5 = f"{prefix:03d}{random.randint(0, 99):02d}"

        out = {
            "locality": locality,
            "region": abbr,
            "postcode": zip5,
            "country": "US",
        }
        output_handle.write(json.dumps(out, ensure_ascii=False) + "\n")
        emitted += 1

    conn.close()
    return emitted


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--shards", nargs="*", type=Path, default=[])
    p.add_argument("--sqlite", type=Path)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--limit", type=int)
    args = p.parse_args()

    total = 0
    with args.output.open("w", encoding="utf-8") as out:
        for shard in args.shards:
            print(f"  reading {shard}...", file=sys.stderr)
            total += extract_from_parquet(shard, out, args.limit)
        if args.sqlite:
            print(f"  reading {args.sqlite}...", file=sys.stderr)
            total += extract_from_sqlite(args.sqlite, out, args.limit)

    print(f"Wrote {total} tuples to {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
