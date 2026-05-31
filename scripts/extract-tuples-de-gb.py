#!/usr/bin/env python3
"""Extract (locality, region, postcode, country) tuples for DE + GB from the WOF admin
SQLite DB, with synthetic plausible postcodes. Output: JSONL ready for
`scripts/build-no-street-shard.mjs`.

This complements `extract-tuples.py` (which is US-only on its SQLite path). The point of
DE/GB tuples specifically is the bilingual no-street shard recommended by DeepSeek turn 7:
a small amount of non-US anti-decompose signal that doesn't commit us to the full v0.7
locale-expansion scope.

Postcode generation strategy:

- **DE** (5-digit ZIP). German postcodes are organized into ten leading-digit regions
  (`0X` is Saxony/Thuringia, `1X` is Brandenburg/Berlin, `8X` is southern Bavaria, etc.).
  Per region, we sample from a state-appropriate range. The model is learning the SHAPE
  (5 digits, 2-digit prefix consistent with the locality's region), not the exact mapping.
- **GB** (alphanumeric). UK postcodes are `<area><district> <sector><unit>` —
  e.g. `W1J 5LJ`, `SW1A 1AA`, `EC1V 9HG`. Areas correspond to regions (London = various
  inner-area codes; Manchester = `M`; etc.). We use a per-region prefix table and
  generate a synthetic sector+unit on the fly.

Usage:
  python3 scripts/extract-tuples-de-gb.py \\
    --sqlite /mnt/playpen/mailwoman-data/wof/admin-global-priority.db \\
    --output /tmp/tuples-de-gb.jsonl \\
    --limit-de 5000 --limit-gb 5000
"""

import argparse
import json
import random
import sqlite3
import string
import sys
from pathlib import Path


# --- DE postcode prefix mapping (per state, leading digits) -------------------------------
# Per https://en.wikipedia.org/wiki/Postal_codes_in_Germany — approximate by state.
DE_REGION_POSTCODES = {
    "Sachsen": (10, 19),       # 01xxx–09xxx
    "Saxony": (10, 19),
    "Berlin": (101, 141),
    "Brandenburg": (140, 199),
    "Mecklenburg-Vorpommern": (170, 199),
    "Hamburg": (200, 229),
    "Schleswig-Holstein": (230, 270),
    "Niedersachsen": (260, 380),
    "Lower Saxony": (260, 380),
    "Bremen": (270, 289),
    "Nordrhein-Westfalen": (320, 599),
    "North Rhine-Westphalia": (320, 599),
    "Hessen": (340, 360),
    "Hesse": (340, 360),
    "Rheinland-Pfalz": (550, 569),
    "Rhineland-Palatinate": (550, 569),
    "Saarland": (660, 669),
    "Baden-Württemberg": (680, 799),
    "Bayern": (800, 989),
    "Bavaria": (800, 989),
    "Thüringen": (980, 999),
    "Thuringia": (980, 999),
}
DE_DEFAULT_RANGE = (100, 999)


# --- GB area-code prefix mapping (per region) --------------------------------------------
# https://en.wikipedia.org/wiki/Postcodes_in_the_United_Kingdom — approximate by region.
GB_REGION_AREAS = {
    "England": ["B", "BR", "BS", "CB", "CO", "CT", "DA", "DT", "E", "EC", "EN", "GU", "HA",
                "KT", "L", "LE", "LN", "M", "ME", "MK", "N", "NE", "NW", "OX", "PE", "PO",
                "RG", "RH", "SE", "SK", "SL", "SM", "SO", "SR", "SS", "SW", "TF", "TN",
                "TS", "TW", "UB", "W", "WA", "WC", "WD", "WN", "WR", "WS", "WV", "YO"],
    "Scotland": ["AB", "DD", "DG", "EH", "FK", "G", "IV", "KA", "KW", "KY", "ML", "PA", "PH", "TD"],
    "Wales": ["CF", "LD", "LL", "NP", "SA", "SY"],
    "Northern Ireland": ["BT"],
}
GB_DEFAULT_AREAS = ["B", "M", "L", "S", "N", "SW", "SE", "E", "EC", "W", "WC"]


def gen_de_postcode(region: str, rng: random.Random) -> str:
    lo, hi = DE_REGION_POSTCODES.get(region, DE_DEFAULT_RANGE)
    prefix = rng.randint(lo, hi)
    suffix = rng.randint(0, 99)
    return f"{prefix:03d}{suffix:02d}"


def gen_gb_postcode(region: str, rng: random.Random) -> str:
    areas = GB_REGION_AREAS.get(region, GB_DEFAULT_AREAS)
    area = rng.choice(areas)
    # District: 1-2 digits, sometimes with a trailing letter (W1A, E14, EC1V).
    district = str(rng.randint(1, 99))
    if rng.random() < 0.2:
        district += rng.choice(string.ascii_uppercase)
    sector = str(rng.randint(0, 9))
    unit = "".join(rng.choices(string.ascii_uppercase, k=2))
    return f"{area}{district} {sector}{unit}"


def extract_country(db_path: Path, country: str, limit: int, rng: random.Random) -> list[dict]:
    conn = sqlite3.connect(str(db_path))
    cur = conn.cursor()
    # WOF hierarchy: locality → (county) → region → country. The intermediate county isn't
    # always present for DE/GB so we join directly through parent_id to find the closest
    # ancestor with a non-empty name.
    cur.execute(
        """
        SELECT s.id, s.name, p.name as parent_name, p.placetype
        FROM spr s
        LEFT JOIN spr p ON s.parent_id = p.id
        WHERE s.country = ? AND s.placetype = 'locality' AND s.is_current = 1
        ORDER BY RANDOM()
        LIMIT ?
        """,
        (country, limit),
    )

    # For DE/GB the immediate parent may be a county; we want the region name. Walk up if
    # needed using a quick lookup.
    spr_by_id_query = "SELECT name, placetype, parent_id FROM spr WHERE id = ?"
    region_cache: dict[int, str] = {}

    def resolve_region(start_id: int | None) -> str | None:
        cur2 = conn.cursor()
        seen = set()
        cur_id = start_id
        while cur_id and cur_id > 0 and cur_id not in seen:
            seen.add(cur_id)
            if cur_id in region_cache:
                return region_cache[cur_id]
            cur2.execute(spr_by_id_query, (cur_id,))
            row = cur2.fetchone()
            if not row:
                return None
            name, placetype, parent_id = row
            if placetype == "region":
                region_cache[cur_id] = name
                return name
            cur_id = parent_id
        return None

    out: list[dict] = []
    pc_gen = gen_de_postcode if country == "DE" else gen_gb_postcode if country == "GB" else None
    if not pc_gen:
        raise ValueError(f"unsupported country {country}")

    for sid, locality, parent_name, parent_placetype in cur:
        if not locality:
            continue
        if parent_placetype == "region" and parent_name:
            region = parent_name
        else:
            region = resolve_region(sid)
            if not region:
                continue
        postcode = pc_gen(region, rng)
        out.append({
            "locality": locality,
            "region": region,
            "postcode": postcode,
            "country": country,
        })

    conn.close()
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--sqlite", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--limit-de", type=int, default=5000)
    p.add_argument("--limit-gb", type=int, default=5000)
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()

    rng = random.Random(args.seed)
    print(f"Extracting up to {args.limit_de} DE + {args.limit_gb} GB tuples...", file=sys.stderr)

    de = extract_country(args.sqlite, "DE", args.limit_de, rng)
    print(f"  DE: {len(de)} tuples", file=sys.stderr)
    gb = extract_country(args.sqlite, "GB", args.limit_gb, rng)
    print(f"  GB: {len(gb)} tuples", file=sys.stderr)

    with args.output.open("w", encoding="utf-8") as out:
        for row in de + gb:
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"Wrote {len(de) + len(gb)} tuples to {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
