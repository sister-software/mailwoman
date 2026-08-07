"""
Build the probe-2 inputs: addresses that exist ONLY as an interpolation, never as an indexed point.

§3's second probe needs an address with no point record, and the panel cannot supply one — every
panel row's truth is a surveyed coordinate, which is the definition of not-interpolation-class. So
the inputs come from the interpolation build's own `address.db`, and the selection leans on a
property of its schema rather than on a guess.

THE SCHEMA DOES THE FILTERING FOR US. `address.db`'s table carries
`UNIQUE(id, housenumber) ON CONFLICT IGNORE`, and `build-c-shape.sh` runs OpenAddresses before TIGER.
So a surviving row with `source = 'TIGER'` is one where OpenAddresses had NOTHING for that street and
housenumber — the conflict would have dropped the TIGER row otherwise. Same argument for OSM rows on
a street OA never covered. No separate absence check is needed, and that is worth more than one:
absence proved by construction beats absence proved by a query that could be asking wrongly.

The truth coordinate is the interpolated point itself, so this probe measures WIRING — does a query
with no point record still come back with a coordinate on the right street — and not accuracy. That
is exactly what §3 asks of it; the accuracy question belongs to the benchmark, which never uses
these rows.

Usage:
  python3 make-interpolation-probes.py --address-db /path/address.db --street-db /path/street.db \\
      --source TIGER --country US --limit 5 [--out probes.jsonl]
"""

import json
import math
import sqlite3
import sys
import urllib.parse
import urllib.request

ES = "http://localhost:9200/pelias"


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def nearest_locality(lat, lon):
    """The enclosing town, so the query string looks like something a person would type."""
    body = json.dumps(
        {
            "size": 1,
            "query": {"bool": {"filter": [{"term": {"layer": "locality"}}]}},
            "sort": [{"_geo_distance": {"center_point": {"lat": lat, "lon": lon}, "order": "asc", "unit": "km"}}],
        }
    ).encode()
    req = urllib.request.Request(
        f"{ES}/_search", data=body, headers={"Content-Type": "application/json"}
    )
    try:
        hits = json.load(urllib.request.urlopen(req, timeout=30))["hits"]["hits"]
    except Exception:
        return None
    if not hits:
        return None
    src = hits[0]["_source"]
    names = src.get("name", {}).get("default")
    return names[0] if isinstance(names, list) else names


def main():
    address_db = arg("--address-db")
    street_db = arg("--street-db")
    source = arg("--source", "TIGER")
    country = arg("--country", "US")
    limit = int(arg("--limit", "5"))
    out_path = arg("--out")

    db = sqlite3.connect(f"file:{address_db}?mode=ro", uri=True)
    db.execute(f"ATTACH DATABASE 'file:{street_db}?mode=ro' AS street")

    # Spread the sample across the id space rather than taking the first N — the first N are one
    # county, and a probe that only ever exercises one county is not a country probe.
    rows = db.execute(
        """
        SELECT a.id, a.housenumber, a.lat, a.lon, a.source_id, n.name
        FROM address a
        JOIN street.names n ON n.id = a.id
        WHERE a.source = ?
          AND a.housenumber = CAST(a.housenumber AS INTEGER)
          AND a.lat IS NOT NULL
        GROUP BY a.id
        ORDER BY a.id * 2654435761 % 1000003
        LIMIT ?
        """,
        (source, limit * 4),
    ).fetchall()

    probes = []
    for street_id, housenumber, lat, lon, source_id, name in rows:
        if len(probes) >= limit:
            break
        locality = nearest_locality(lat, lon)
        if not locality:
            continue
        probes.append(
            {
                "id": f"interp-{country}-{len(probes) + 1:03d}",
                "country": country,
                "input": f"{int(housenumber)} {name}, {locality}",
                "truth_lat": lat,
                "truth_lon": lon,
                "truth_type": "interpolation",
                "local_coverage_hint": f"{source}_range",
                "source": f"address.db street_id={street_id} source_id={source_id}",
            }
        )

    for p in probes:
        print(json.dumps(p))
    if out_path:
        with open(out_path, "a") as fh:
            for p in probes:
                fh.write(json.dumps(p) + "\n")


if __name__ == "__main__":
    main()
