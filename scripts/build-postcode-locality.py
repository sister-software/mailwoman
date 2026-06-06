#!/usr/bin/env python3
"""Build the postcode -> containing-locality candidate table (#274), offline, FROM SOURCE.

The PIP-containment probe (#274 groundwork) showed coordinate-first resolution lifts German locality
accuracy where name-match misses (Sachsen +22pp). This productizes it: for every postcode, point-in-
polygon its centroid against the WOF locality polygons and record the containing locality (+ a few
nearby ones for the abutting-postcode / soft-scoring candidate set), with WOF alt-name aliases.

The resolver consumes this at resolve time: postcode -> candidate localities -> soft-score by
(postcode-proximity + name-match) -> pick. It supplies the COORDINATE candidate the FTS name-match
can't generate when a small town isn't well-indexed.

BUILD-FROM-SOURCE per the standing rule: locality polygons from the whosonfirst-data-admin-<cc>
GeoJSON repos; postcode centroids from our own custom-built postalcode-intl.db (NOT a prebuilt dump).

Usage:
  python3 scripts/build-postcode-locality.py --country DE \
    --admin-repo /mnt/playpen/mailwoman-data/wof/repos/whosonfirst-data/whosonfirst-data-admin-de \
    --postcode-db /mnt/playpen/mailwoman-data/wof/postalcode-intl.db \
    --output /mnt/playpen/mailwoman-data/wof/postcode-locality-de.db \
    --radius-km 10 --max-candidates 4
"""
import argparse, glob, json, math, os, sqlite3, collections

def ray_in_ring(x, y, ring):
    inside, n, j = False, len(ring), len(ring) - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]; xj, yj = ring[j][0], ring[j][1]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside
def in_poly(x, y, poly):
    c = False
    for ring in poly:
        if ray_in_ring(x, y, ring): c = not c
    return c
def in_geom(x, y, geom):
    t = geom["type"]
    if t == "Polygon": return in_poly(x, y, geom["coordinates"])
    if t == "MultiPolygon": return any(in_poly(x, y, p) for p in geom["coordinates"])
    return False
def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(math.sqrt(a))

ALT_NAME_KEYS = ("wof:label",)  # plus name:* / label:* props, gathered below

def aliases_for(props, canonical):
    out = set()
    for k, v in props.items():
        if (k.startswith("name:") or k.startswith("label:") or k in ALT_NAME_KEYS) and isinstance(v, str):
            out.add(v)
        elif (k.startswith("name:") or k.startswith("label:")) and isinstance(v, list):
            out.update(x for x in v if isinstance(x, str))
    out.discard(canonical)
    return sorted(out)

def finalize(output):
    """Freeze the accumulated table into a self-contained, read-only, distributable sqlite asset (the
    same shape as our other WOF tables): a provenance/license `meta` table, query-planner stats, an
    integrity check, a rollback (non-WAL) journal mode so there's no sidecar, and a VACUUM to compact."""
    import datetime
    db = sqlite3.connect(output)
    counts = db.execute(
        "SELECT country, COUNT(*), SUM(is_containing) FROM postcode_locality GROUP BY country ORDER BY country"
    ).fetchall()
    summary = {c: {"rows": n, "containing": int(con or 0)} for (c, n, con) in counts}
    db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    meta = {
        "name": "mailwoman-postcode-locality",
        "description": "postcode → containing + nearby WOF locality candidates (coordinate-first resolution)",
        "schema_version": "1",
        "built_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "source": "Who's On First (whosonfirst.org) — admin locality polygons + postalcode centroids; built from source GeoJSON, not a prebuilt dump",
        "license": "CC-BY 4.0 (Who's On First) — attribution required on redistribution",
        "attribution": "Contains data from Who's On First, © Who's On First contributors, CC-BY 4.0",
        "method": "point-in-polygon of each postcode centroid against WOF locality polygons (+ a ~10km nearby candidate set with alt-name aliases)",
        "countries": json.dumps(summary, sort_keys=True),
    }
    db.executemany("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", list(meta.items()))
    db.commit()
    db.execute("PRAGMA journal_mode = DELETE")  # no -wal/-shm sidecar; the .db is self-contained
    db.execute("ANALYZE")
    ok = db.execute("PRAGMA integrity_check").fetchone()[0]
    if ok != "ok":
        raise SystemExit(f"integrity_check failed: {ok}")
    db.commit()
    db.execute("VACUUM")
    db.close()
    print(f"finalized {output}: integrity=ok, countries={summary}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--country")
    ap.add_argument("--admin-repo")
    ap.add_argument("--postcode-db")
    ap.add_argument("--output", required=True)
    ap.add_argument("--radius-km", type=float, default=10.0)
    ap.add_argument("--max-candidates", type=int, default=4)
    ap.add_argument("--finalize", action="store_true",
                    help="freeze the accumulated table into a read-only distributable asset (meta + VACUUM + integrity); no rebuild")
    args = ap.parse_args()

    if args.finalize:
        finalize(args.output)
        return
    if not (args.country and args.admin_repo and args.postcode_db):
        raise SystemExit("build mode needs --country, --admin-repo, --postcode-db (or pass --finalize)")

    print(f"loading {args.country} locality polygons from source GeoJSON…")
    locs = []  # dict: id, name, aliases, clat, clon, bbox, geom
    for fp in glob.glob(args.admin_repo + "/data/**/*.geojson", recursive=True):
        try:
            g = json.load(open(fp)); p = g.get("properties", {})
            if p.get("wof:placetype") != "locality" or p.get("mz:is_current", 1) == 0: continue
            geom = g.get("geometry")
            if not geom or geom["type"] not in ("Polygon", "MultiPolygon"): continue
            xs, ys = [], []
            def walk(c):
                if isinstance(c[0], (int, float)): xs.append(c[0]); ys.append(c[1])
                else:
                    for cc in c: walk(cc)
            walk(geom["coordinates"])
            name = p.get("wof:name", "")
            clat = p.get("lbl:latitude") if isinstance(p.get("lbl:latitude"), (int, float)) else (min(ys)+max(ys))/2
            clon = p.get("lbl:longitude") if isinstance(p.get("lbl:longitude"), (int, float)) else (min(xs)+max(xs))/2
            locs.append({"id": int(p["wof:id"]), "name": name, "aliases": aliases_for(p, name),
                         "clat": clat, "clon": clon,
                         "bbox": (min(xs), min(ys), max(xs), max(ys)), "geom": geom})
        except Exception:
            pass
    print(f"  {len(locs)} localities")

    # Two 0.1°-cell (~11km) grid indexes. `grid` (by centroid) drives the radius candidate set; `bgrid`
    # (by bbox-spanned cells — a locality is registered in every cell its bounding box overlaps) drives
    # the containing-PIP, so it checks only the localities whose bbox could cover the point instead of a
    # linear scan over all of them. At GB scale (2.7M postcodes × 11.7K localities) that's the
    # difference between minutes and ~an hour.
    grid = collections.defaultdict(list)
    bgrid = collections.defaultdict(list)
    for idx, l in enumerate(locs):
        grid[(round(l["clon"]*10), round(l["clat"]*10))].append(idx)
        minx, miny, maxx, maxy = l["bbox"]
        for cx in range(int(math.floor(minx*10)), int(math.floor(maxx*10)) + 1):
            for cy in range(int(math.floor(miny*10)), int(math.floor(maxy*10)) + 1):
                bgrid[(cx, cy)].append(idx)

    con = sqlite3.connect(args.postcode_db)
    postcodes = con.execute(
        "SELECT name, latitude, longitude FROM spr WHERE country=? AND placetype='postalcode' AND is_current!=0",
        (args.country,)).fetchall()
    con.close()
    print(f"  {len(postcodes)} {args.country} postcode centroids")

    out = sqlite3.connect(args.output)
    # Accumulate per country into one shared DB (the resolver attaches a SINGLE postcode_locality
    # shard and country-filters at query time). CREATE-IF-NOT-EXISTS + DELETE-this-country makes each
    # --country run idempotent, so `--output postcode-locality-intl.db` can be filled DE, FR, … in turn.
    out.execute("""CREATE TABLE IF NOT EXISTS postcode_locality (
        postcode TEXT NOT NULL, country TEXT NOT NULL, locality_id INTEGER NOT NULL,
        locality_name TEXT NOT NULL, aliases TEXT, distance_km REAL NOT NULL,
        is_containing INTEGER NOT NULL)""")
    out.execute("DELETE FROM postcode_locality WHERE country = ?", (args.country,))

    rows, n_contained = 0, 0
    for (pc, plat, plon) in postcodes:
        if plat is None or plon is None: continue
        # containing locality via bbox-grid-prefiltered PIP (only localities whose bbox spans this cell)
        containing_idx = None
        for idx in bgrid.get((int(math.floor(plon*10)), int(math.floor(plat*10))), ()):
            l = locs[idx]
            minx, miny, maxx, maxy = l["bbox"]
            if minx <= plon <= maxx and miny <= plat <= maxy and in_geom(plon, plat, l["geom"]):
                containing_idx = idx; break
        # nearby candidates within radius (grid-limited) for the soft-scoring candidate set + abutting case
        cand = []
        gx, gy = round(plon*10), round(plat*10)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for idx in grid.get((gx+dx, gy+dy), ()):
                    d = haversine(plat, plon, locs[idx]["clat"], locs[idx]["clon"])
                    if d <= args.radius_km: cand.append((d, idx))
        cand.sort()
        chosen = []
        if containing_idx is not None:
            chosen.append((0.0, containing_idx, 1)); n_contained += 1
        for d, idx in cand:
            if idx == containing_idx: continue
            if len([c for c in chosen if c[2] == 0]) >= args.max_candidates: break
            chosen.append((d, idx, 0))
        for d, idx, isc in chosen:
            l = locs[idx]
            out.execute("INSERT INTO postcode_locality VALUES (?,?,?,?,?,?,?)",
                        (pc, args.country, l["id"], l["name"], "|".join(l["aliases"]), round(d, 3), isc))
            rows += 1
    out.execute("CREATE INDEX IF NOT EXISTS postcode_locality_by_pc ON postcode_locality(postcode, country)")
    out.commit()
    print(f"  wrote {rows} rows ({n_contained}/{len(postcodes)} postcodes have a containing locality) → {args.output}")
    out.close()

if __name__ == "__main__":
    main()
