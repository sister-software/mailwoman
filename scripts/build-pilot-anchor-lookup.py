#!/usr/bin/env python3
"""Build the postcode→anchor lookup for the de-risk pilot (#239/#240).

Emits a JSON ``{normalized_postcode: [posterior_dict, lat, lon, source]}`` for the pilot locales
(DE/FR/US), loaded once at training-loader init (``data.anchor_lookup_path``) so the training loop
carries no gazetteer dependency. This is the offline, deterministic precompute DeepSeek recommended.

- **posterior**: UNIFORM over the countries whose postal gazetteer contains the code (the posterior
  the A/B measurement settled on — `docs/articles/evals/2026-06-05-postcode-posterior-ab.md`). A
  German PLZ that collides with a US ZIP (e.g. 10115) comes back ``{"DE": 0.5, "US": 0.5}``.
- **centroid**: taken from the first source that has a real centroid, in DE→FR→US order, so the
  collapse-relevant European rows get a European centroid on a collision. The centroid is the
  secondary signal (the posterior + the categorical anchor cue do the work).
- **source** (#525, the no-load-bearing-trivia rule): names the dataset the centroid came from —
  ``wof`` (our WOF postcode shards, which may themselves carry provenanced backfills; see the
  ``centroid_source`` table), ``census-zcta-2024`` (Census ZCTA Gazetteer fill, either already in
  the DB or joined here via ``--zcta``), or ``null`` for a placeholder (membership only). Loaders
  that predate the field tolerate its absence; ``data_loader.load_anchor_lookup`` ignores it.

Sources (build-from-source, never prebuilt): postalcode-intl.db (DE/FR, inline centroids) +
postalcode-us.db (US; spr centroids are real post-backfill — the old place_bbox-midpoint path read
column names that don't exist in the R-tree (`min_latitude` vs `min_lat`) and silently zeroed
every US centroid, the bulk of the 38% placeholder rate #525 fixed).

ZCTA caveat: ZCTAs approximate delivery areas, not ZIPs — PO-box-only/unique ZIPs have no ZCTA and
stay placeholder. Vintage + URL: /mnt/playpen/mailwoman-data/census/README.md.

Usage:
  python3 scripts/build-pilot-anchor-lookup.py \
    --zcta /mnt/playpen/mailwoman-data/census/2024_Gaz_zcta_national.txt \
    --output /mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json
"""
import argparse
import json
import sqlite3

WOF = "/mnt/playpen/mailwoman-data/wof"
ZCTA_SOURCE = "census-zcta-2024"  # keep in sync with scripts/zcta-centroids.ts

# (lat, lon, source): source is None when the row is a placeholder (membership only).
Centroid = tuple[float, float, str | None]


def five_digit(name: str) -> str | None:
    name = (name or "").strip().upper()
    return name if len(name) == 5 and name.isdigit() else None


def _placed(lat: float, lon: float) -> bool:
    return lat != 0.0 or lon != 0.0


def load_intl(country: str) -> dict[str, Centroid]:
    """DE/FR postcodes → centroid from postalcode-intl.db (inline lat/lon)."""
    out: dict[str, Centroid] = {}
    con = sqlite3.connect(f"{WOF}/postalcode-intl.db")
    for name, lat, lon in con.execute(
        "SELECT name, latitude, longitude FROM spr WHERE placetype='postalcode' AND country=?", (country,)
    ):
        pc = five_digit(name)
        if pc:
            lat, lon = float(lat), float(lon)
            out[pc] = (lat, lon, "wof" if _placed(lat, lon) else None)
    con.close()
    return out


def load_us() -> dict[str, Centroid]:
    """US postcodes → spr centroid, with per-row provenance from `centroid_source` when present
    (rows the ZCTA fill placed carry `census-zcta-2024`; untracked placed rows are `wof`)."""
    out: dict[str, Centroid] = {}
    con = sqlite3.connect(f"{WOF}/postalcode-us.db")
    has_sources = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='centroid_source'"
    ).fetchone()
    src_join = "LEFT JOIN centroid_source cs ON cs.id=spr.id" if has_sources else ""
    src_col = "cs.source" if has_sources else "NULL"
    for name, lat, lon, src in con.execute(
        f"SELECT spr.name, spr.latitude, spr.longitude, {src_col} FROM spr {src_join} "
        "WHERE spr.placetype='postalcode' AND spr.is_current!=0"
    ):
        pc = five_digit(name)
        if pc:
            lat, lon = float(lat), float(lon)
            out[pc] = (lat, lon, (src or "wof") if _placed(lat, lon) else None)
    con.close()
    return out


def load_zcta(path: str) -> dict[str, tuple[float, float]]:
    """Census ZCTA Gazetteer file → 5-digit code → internal-point centroid (mirror of
    scripts/zcta-centroids.ts::parseZctaCentroids)."""
    out: dict[str, tuple[float, float]] = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            fields = [f.strip() for f in line.split("\t")]
            pc = five_digit(fields[0]) if fields else None
            if not pc or len(fields) < 7:
                continue
            try:
                lat, lon = float(fields[5]), float(fields[6])
            except ValueError:
                continue
            if _placed(lat, lon):
                out[pc] = (lat, lon)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", required=True)
    ap.add_argument("--zcta", help="Census ZCTA Gazetteer .txt: fill US placeholder centroids (#525)")
    args = ap.parse_args()

    sources = [("DE", load_intl("DE")), ("FR", load_intl("FR")), ("US", load_us())]  # centroid priority order
    zcta = load_zcta(args.zcta) if args.zcta else {}
    all_codes: set[str] = set()
    for _c, d in sources:
        all_codes |= set(d.keys())

    lookup: dict[str, list] = {}
    collisions = zcta_filled = 0
    for pc in sorted(all_codes):
        members = [c for c, d in sources if pc in d]
        k = len(members)
        posterior = {c: 1.0 / k for c in members}
        if k > 1:
            collisions += 1
        # centroid: first source (DE→FR→US) with a non-zero centroid; never overwritten by ZCTA.
        lat, lon, source = 0.0, 0.0, None
        for c, d in sources:
            if pc in d and _placed(d[pc][0], d[pc][1]):
                lat, lon, source = d[pc]
                break
        # ZCTA fill: placeholders only, US members only (#525).
        if source is None and "US" in members and pc in zcta:
            lat, lon = zcta[pc]
            source = ZCTA_SOURCE
            zcta_filled += 1
        lookup[pc] = [posterior, round(lat, 5), round(lon, 5), source]

    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(lookup, fh, ensure_ascii=False)

    by_country = {c: sum(1 for v in lookup.values() if c in v[0]) for c, _ in sources}
    by_source: dict[str | None, int] = {}
    for v in lookup.values():
        by_source[v[3]] = by_source.get(v[3], 0) + 1
    placeholders = by_source.get(None, 0)
    print(
        f"{len(lookup):,} postcodes → {args.output}  "
        f"(DE {by_country['DE']:,}, FR {by_country['FR']:,}, US {by_country['US']:,}; "
        f"{collisions:,} collisions; {zcta_filled:,} ZCTA-filled here; "
        f"sources {({k or 'placeholder': n for k, n in sorted(by_source.items(), key=lambda kv: -kv[1])})}; "
        f"{placeholders:,} no-centroid = {100 * placeholders / len(lookup):.1f}%)"
    )


if __name__ == "__main__":
    main()
