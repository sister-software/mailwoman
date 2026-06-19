#!/usr/bin/env python3
"""
@copyright Sister Software
@license AGPL-3.0
@author Teffen Ellis, et al.

Build a resolver gazetteer SHARD from the Overture Maps `divisions` theme, for locales the
WhosOnFirst-built admin-global-priority.db doesn't cover (PT/PL/BE/AT/... — the zero-DB EU locales,
2026-06-20 coordinate-leverage sprint). NOT a replacement for the custom WOF DB (feedback-custom-wof-db-only)
— a supplementary SHARD used alongside it (the resolver takes databasePath: string[]). Overture divisions
carry locality/region/county admin units with names + centroids + a parent hierarchy for every country;
build-unified-wof is WOF-GeoJSON-only and the WOF SQLite bundles are gone, so Overture divisions is the
fast, queryable source.

Schema: mirrors the live admin DB (spr + names + ancestors + place_population); FTS (place_search +
place_bbox) is added afterward by `node resolver-wof-sqlite/out/build-fts-cli.js <db>`. Synthetic numeric
ids are based at 8e12 (WOF ids are <~2e9, so no cross-shard collision).

Usage: python3 scripts/build-overture-divisions-gazetteer.py --countries PT,PL,BE --out /mnt/playpen/mailwoman-data/wof/admin-overture-eu.db [--release 2026-06-17.0]
"""
import argparse, sqlite3, os, duckdb

ap = argparse.ArgumentParser()
ap.add_argument("--countries", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--release", default="2026-06-17.0")
args = ap.parse_args()
countries = [c.strip().upper() for c in args.countries.split(",")]
G = f"s3://overturemaps-us-west-2/release/{args.release}/theme=divisions/type=division/*"
ID_BASE = 8_000_000_000_000  # above any real WOF id → safe in a multi-shard resolver

con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2'; SET memory_limit='7GB'; SET threads=4; SET enable_progress_bar=false;")
inlist = ",".join(f"'{c}'" for c in countries)
# locality/region/county = the admin units the resolver places to. localadmin-ish granularity is fine.
rows = con.execute(f"""
  SELECT id,
         names.primary AS name,
         subtype,
         country,
         ST_Y(ST_Centroid(geometry)) AS lat,
         ST_X(ST_Centroid(geometry)) AS lon,
         bbox.ymin AS min_lat, bbox.ymax AS max_lat, bbox.xmin AS min_lon, bbox.xmax AS max_lon,
         parent_division_id,
         population
  FROM read_parquet('{G}')
  WHERE country IN ({inlist}) AND subtype IN ('locality','region','county','localadmin')
        AND names.primary IS NOT NULL AND geometry IS NOT NULL
""").fetchall()
print(f"divisions pulled: {len(rows)} across {countries}")

# gers id -> synthetic int
idmap = {}
for i, r in enumerate(rows):
    idmap[r[0]] = ID_BASE + i

if os.path.exists(args.out):
    os.remove(args.out)
db = sqlite3.connect(args.out)
db.executescript("""
CREATE TABLE spr (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
  latitude REAL, longitude REAL, min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
  is_current INTEGER, is_deprecated INTEGER, is_ceased INTEGER, is_superseded INTEGER, is_superseding INTEGER, lastmodified INTEGER);
CREATE TABLE names (id INTEGER, name TEXT, placetype TEXT, country TEXT, language TEXT, privateuse TEXT, lastmodified INTEGER);
CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);
CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER);
-- Empty stubs so the multi-shard resolver's resolveTree (which LEFT JOINs these) doesn't error
-- when this shard is the queried one. Overture divisions carry neither concordances nor the
-- dual-role (coincident) relation; an empty table is schema-faithful and resolves to "no rows".
CREATE TABLE concordances (id INTEGER NOT NULL, other_id TEXT NOT NULL, other_source TEXT NOT NULL, lastmodified INTEGER NOT NULL DEFAULT 0);
CREATE TABLE coincident_roles (admin_id INTEGER NOT NULL, locality_id INTEGER NOT NULL, relationship_type TEXT NOT NULL, admin_placetype TEXT NOT NULL, distance_km REAL NOT NULL, locality_population INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (admin_id, locality_id));
""")

parent_gers = {r[0]: r[10] for r in rows}
spr_rows, name_rows, anc_rows, pop_rows = [], [], [], []
ptmap = {r[0]: r[2] for r in rows}
for r in rows:
    gers, name, subtype, country, lat, lon, mnlat, mxlat, mnlon, mxlon, pgers, pop = r
    nid = idmap[gers]
    pid = idmap.get(pgers)
    spr_rows.append((nid, pid, name, subtype, country, lat, lon, mnlat, mnlon, mxlat, mxlon, 1, 0, 0, 0, 0, 0))
    name_rows.append((nid, name, subtype, country, "", "", 0))
    if pop is not None:
        pop_rows.append((nid, int(pop)))
    # walk the parent chain → ancestors (id, ancestor_id, ancestor_placetype)
    cur = pgers
    while cur is not None and cur in idmap:
        anc_rows.append((nid, idmap[cur], ptmap.get(cur)))
        cur = parent_gers.get(cur)

db.executemany("INSERT INTO spr VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", spr_rows)
db.executemany("INSERT INTO names VALUES (?,?,?,?,?,?,?)", name_rows)
db.executemany("INSERT INTO ancestors VALUES (?,?,?)", anc_rows)
db.executemany("INSERT INTO place_population VALUES (?,?)", pop_rows)
db.executescript("CREATE INDEX idx_spr_country ON spr(country); CREATE INDEX idx_names_id ON names(id); CREATE INDEX idx_anc_aid ON ancestors(ancestor_id); CREATE INDEX idx_anc_id ON ancestors(id);")
db.commit()
from collections import Counter
c = Counter(r[3] for r in spr_rows)
print(f"wrote {args.out}: {len(spr_rows)} spr ({dict(c)}), {len(anc_rows)} ancestors, {len(pop_rows)} pop")
print("NEXT: node resolver-wof-sqlite/out/build-fts-cli.js", args.out)
db.close()
