#!/usr/bin/env python3
"""Build the postcode→anchor lookup for the de-risk pilot (#239/#240).

Emits a JSON ``{normalized_postcode: [posterior_dict, lat, lon]}`` for the pilot locales (DE/FR/US),
loaded once at training-loader init (``data.anchor_lookup_path``) so the training loop carries no
gazetteer dependency. This is the offline, deterministic precompute DeepSeek recommended.

- **posterior**: UNIFORM over the countries whose postal gazetteer contains the code (the posterior
  the A/B measurement settled on — `docs/articles/evals/2026-06-05-postcode-posterior-ab.md`). A
  German PLZ that collides with a US ZIP (e.g. 10115) comes back ``{"DE": 0.5, "US": 0.5}``.
- **centroid**: taken from the first source that has a real centroid, in DE→FR→US order, so the
  collapse-relevant European rows get a European centroid on a collision. The centroid is the
  secondary signal (the posterior + the categorical anchor cue do the work); the pilot doesn't lean
  on it.

Sources (build-from-source, never prebuilt): postalcode-intl.db (DE/FR, inline centroids) +
postalcode-us.db (US set + place_bbox midpoints, since its spr centroids are 0).

Usage:
  python3 scripts/build-pilot-anchor-lookup.py --output /mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json
"""
import argparse
import json
import sqlite3

WOF = "/mnt/playpen/mailwoman-data/wof"


def five_digit(name: str) -> str | None:
    name = (name or "").strip().upper()
    return name if len(name) == 5 and name.isdigit() else None


def load_intl(country: str) -> dict[str, tuple[float, float]]:
    """DE/FR postcodes → centroid from postalcode-intl.db (inline lat/lon)."""
    out: dict[str, tuple[float, float]] = {}
    con = sqlite3.connect(f"{WOF}/postalcode-intl.db")
    for name, lat, lon in con.execute(
        "SELECT name, latitude, longitude FROM spr WHERE placetype='postalcode' AND country=?", (country,)
    ):
        pc = five_digit(name)
        if pc:
            out[pc] = (float(lat), float(lon))
    con.close()
    return out


def load_us() -> dict[str, tuple[float, float]]:
    """US postcodes → place_bbox midpoint (spr lat/lon are 0 in postalcode-us.db)."""
    out: dict[str, tuple[float, float]] = {}
    con = sqlite3.connect(f"{WOF}/postalcode-us.db")
    # place_bbox rows: (id, min_lat, max_lat, min_lon, max_lon) keyed to spr.id.
    bbox = {
        r[0]: ((r[1] + r[2]) / 2.0, (r[3] + r[4]) / 2.0)
        for r in con.execute("SELECT id, min_latitude, max_latitude, min_longitude, max_longitude FROM place_bbox")
    } if _has_bbox_cols(con) else {}
    for pid, name in con.execute("SELECT id, name FROM spr WHERE placetype='postalcode'"):
        pc = five_digit(name)
        if pc:
            out[pc] = bbox.get(pid, (0.0, 0.0))
    con.close()
    return out


def _has_bbox_cols(con: sqlite3.Connection) -> bool:
    cols = {r[1] for r in con.execute("PRAGMA table_info(place_bbox)")}
    return {"id", "min_latitude", "max_latitude", "min_longitude", "max_longitude"} <= cols


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    sources = [("DE", load_intl("DE")), ("FR", load_intl("FR")), ("US", load_us())]  # centroid priority order
    all_codes: set[str] = set()
    for _c, d in sources:
        all_codes |= set(d.keys())

    lookup: dict[str, list] = {}
    collisions = 0
    for pc in all_codes:
        members = [c for c, d in sources if pc in d]
        k = len(members)
        posterior = {c: 1.0 / k for c in members}
        if k > 1:
            collisions += 1
        # centroid: first source (DE→FR→US) with a non-zero centroid.
        lat = lon = 0.0
        for c, d in sources:
            if pc in d and (d[pc][0] != 0.0 or d[pc][1] != 0.0):
                lat, lon = d[pc]
                break
        lookup[pc] = [posterior, round(lat, 5), round(lon, 5)]

    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(lookup, fh, ensure_ascii=False)

    by_country = {c: sum(1 for v in lookup.values() if c in v[0]) for c, _ in sources}
    print(
        f"{len(lookup):,} postcodes → {args.output}  "
        f"(DE {by_country['DE']:,}, FR {by_country['FR']:,}, US {by_country['US']:,}; "
        f"{collisions:,} collisions; {sum(1 for v in lookup.values() if v[1]==0.0 and v[2]==0.0):,} no-centroid)"
    )


if __name__ == "__main__":
    main()
