"""Build the house-venue tuples input (run-2 contingency — ROAD_TO §10 item 1).

Samples real (street, house_number, locality, region, postcode) tuples from the two LABEL layers
already on disk — the FR BAN address-points DB and the US national-situs per-state DBs — and emits
the `HouseVenueBaseTuple` JSONL the `house-venue` shard recipe consumes (tuples mode). The
synthesizer supplies venue names + templates; this script supplies REAL address material so the
venue rows sit on genuine streets/localities/postcodes rather than a synthetic pool.

Casing: the DBs carry normalized-lowercase surfaces; rows are re-cased to the training register —
US title-case, FR title-case with French particles kept lowercase (de/la/du/des/le/les/…) except
in first position ("Rue de la Huchette", never "Rue De La Huchette").

Split note: these tuples come from BAN/situs LABEL data, the same sources many corpus shards
draw from — that is FINE for this shard (venue rows are synthetic compositions; the eval's venue
fixtures are gauntlet rows + golden venue tags, not a BAN-street holdout). The fr-fragment
reserved-surface discipline does not bind here, but we exclude the fragment board's reserved
street surfaces anyway (cheap, removes any doubt).

Usage:
  uv run python scripts/build_house_venue_tuples.py [--fr 60000] [--us 60000] [--seed 42] \
      [--out $MAILWOMAN_DATA_ROOT/corpus/intermediate/house-venue-tuples-v2.jsonl]
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sqlite3
from pathlib import Path

DATA_ROOT = os.environ.get("MAILWOMAN_DATA_ROOT", "/mnt/playpen/mailwoman-data")
FR_DB = Path(DATA_ROOT) / "ban" / "address-points-fr.db"
US_DIR = Path(DATA_ROOT) / "address-points"
RESERVED = Path("mailwoman/eval-harness/fixtures/ban-fragments-fr.surfaces.txt")

FR_PARTICLES = frozenset("de la du des le les l d au aux et sur sous en un une".split())


def fr_titlecase(s: str) -> str:
    words = s.split()
    out = []
    for i, w in enumerate(words):
        if i > 0 and w in FR_PARTICLES:
            out.append(w)
        elif "'" in w:
            head, _, tail = w.partition("'")
            out.append(head.lower() + "'" + tail.capitalize())
        elif "-" in w:
            out.append("-".join(part.capitalize() for part in w.split("-")))
        else:
            out.append(w.capitalize())
    return " ".join(out)


def us_titlecase(s: str) -> str:
    return " ".join(w.capitalize() for w in s.split())


def sample_db(path: Path, n: int, rng: random.Random) -> list[tuple]:
    """Uniform-ish sample via random rowid probes (the tables are large; ORDER BY RANDOM() scans)."""
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    (max_rowid,) = db.execute("SELECT MAX(rowid) FROM address_point").fetchone()
    if not max_rowid:
        db.close()
        return []
    rows: list[tuple] = []
    seen: set[int] = set()
    attempts = 0
    while len(rows) < n and attempts < n * 8:
        attempts += 1
        rid = rng.randrange(1, max_rowid + 1)
        if rid in seen:
            continue
        seen.add(rid)
        row = db.execute(
            "SELECT street_norm, number, postcode, locality_norm FROM address_point WHERE rowid = ?",
            (rid,),
        ).fetchone()
        if row is None:
            continue
        street, number, postcode, locality = row
        if not street or not number or not postcode or not locality:
            continue
        rows.append((street, number, postcode, locality))
    db.close()
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fr", type=int, default=60_000)
    ap.add_argument("--us", type=int, default=60_000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default=str(Path(DATA_ROOT) / "corpus" / "intermediate" / "house-venue-tuples-v2.jsonl"))
    args = ap.parse_args()
    rng = random.Random(args.seed)

    reserved = set()
    if RESERVED.exists():
        reserved = {ln.strip() for ln in RESERVED.read_text(encoding="utf-8").splitlines() if ln.strip()}

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    n_fr = n_us = skipped_reserved = 0

    with out_path.open("w", encoding="utf-8") as fh:
        # FR: BAN — no region in the FR rendering, but the tuple field is required; carry "".
        for street, number, postcode, locality in sample_db(FR_DB, args.fr, rng):
            if street in reserved:
                skipped_reserved += 1
                continue
            fh.write(
                json.dumps(
                    {
                        "locality": fr_titlecase(locality),
                        "region": "",
                        "postcode": postcode,
                        "country": "FR",
                        "street": fr_titlecase(street),
                        "houseNumber": number,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
            n_fr += 1

        # US: spread across states, region = the state code from the filename.
        state_dbs = sorted(US_DIR.glob("address-points-us-*.db"))
        rng.shuffle(state_dbs)
        per_state = max(1, args.us // len(state_dbs)) if state_dbs else 0
        for db_path in state_dbs:
            if n_us >= args.us:
                break
            state = db_path.stem.rsplit("-", 1)[-1].upper()
            for street, number, postcode, locality in sample_db(db_path, per_state, rng):
                if n_us >= args.us:
                    break
                fh.write(
                    json.dumps(
                        {
                            "locality": us_titlecase(locality),
                            "region": state,
                            "postcode": postcode,
                            "country": "US",
                            "street": us_titlecase(street),
                            "houseNumber": number,
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                n_us += 1

    print(f"{out_path}: FR {n_fr:,} + US {n_us:,} tuples ({skipped_reserved} reserved FR streets skipped)")


if __name__ == "__main__":
    main()
