#!/usr/bin/env python3
"""Coordinate-first ceiling probe (#274) — does PIP'ing the postcode centroid beat name-match resolution?

The PIP-containment metric (#273) showed the German gap is real (Sachsen 54%), and that the postcode
anchor already places addresses at ~1.3km. This probe tests the coordinate-first hypothesis directly:
take each address's POSTCODE CENTROID, point-in-polygon it against the DE locality polygons, and ask —
does the gold OA point fall inside the locality the centroid landed in? If that beats the current 54%
Sachsen containment, the postcode->locality candidate table is the German fix.

Build-from-SOURCE per the standing rule: locality polygons from the whosonfirst-data-admin-de GeoJSON
repo; postcode centroids from our own custom-built postalcode-intl.db (NOT a prebuilt WOF dump).

Usage: python3 scripts/eval/coord-first-probe.py
"""
import json, glob, sqlite3, collections

ADMIN_DE = "/mnt/playpen/mailwoman-data/wof/repos/whosonfirst-data/whosonfirst-data-admin-de/data"
PC_DB = "/mnt/playpen/mailwoman-data/wof/postalcode-intl.db"
SAMPLE = "data/eval/external/openaddresses-de-sample.jsonl"

# ---- ray-cast PIP (even-odd, handles holes + MultiPolygon); x=lon, y=lat ----
def in_ring(x, y, ring):
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
        if in_ring(x, y, ring): c = not c
    return c
def in_geom(x, y, geom):
    t = geom["type"]
    if t == "Polygon": return in_poly(x, y, geom["coordinates"])
    if t == "MultiPolygon": return any(in_poly(x, y, p) for p in geom["coordinates"])
    return False

# ---- load DE current locality polygons (from SOURCE GeoJSON) with bbox prefilter ----
print("loading DE locality polygons from source GeoJSON...")
locs = []  # (id, name, minx, miny, maxx, maxy, geom)
for fp in glob.glob(ADMIN_DE + "/**/*.geojson", recursive=True):
    try:
        g = json.load(open(fp)); p = g.get("properties", {})
        if p.get("wof:placetype") != "locality" or p.get("mz:is_current", 1) == 0: continue
        geom = g.get("geometry")
        if not geom or geom["type"] not in ("Polygon", "MultiPolygon"): continue
        # bbox from coords
        xs, ys = [], []
        def walk(c):
            if isinstance(c[0], (int, float)): xs.append(c[0]); ys.append(c[1])
            else:
                for cc in c: walk(cc)
        walk(geom["coordinates"])
        locs.append((int(p["wof:id"]), p.get("wof:name", ""), min(xs), min(ys), max(xs), max(ys), geom))
    except Exception: pass
print(f"  {len(locs)} DE localities loaded")

def pip_locality(lon, lat):
    """Return (id, name) of the DE locality whose polygon contains (lon,lat), or None."""
    for (lid, name, minx, miny, maxx, maxy, geom) in locs:
        if minx <= lon <= maxx and miny <= lat <= maxy and in_geom(lon, lat, geom):
            return (lid, name)
    return None

# ---- postcode centroids from our custom postalcode-intl.db ----
con = sqlite3.connect(PC_DB)
pc_centroid = {}
for name, lat, lon in con.execute("SELECT name, latitude, longitude FROM spr WHERE country='DE' AND placetype='postalcode'"):
    pc_centroid[name] = (lat, lon)
print(f"  {len(pc_centroid)} DE postcode centroids loaded")

# ---- name-match signal (from the resolver dump, joined by input) ----
# resolved-v072-de.json carries the neural-resolved locality WOF id per row; "name-correct" means that
# resolved locality IS the true containing locality (== name-match PIP-containment from #273).
try:
    dump = {d["input"]: d.get("neuralLocId") for d in json.load(open("/tmp/resolved-v072-de.json"))}
except Exception:
    dump = {}

# Load the resolver's resolved-locality polygon by WOF id (same as scripts/eval/pip-containment.py) so
# "name-correct" = gold point inside the RESOLVER's chosen polygon (== #273's 77.1%), not an id-equality
# against our independently-PIP'd truth (which mismatches on granularity, e.g. Berlin city vs borough).
import os
_admin_roots = sorted(glob.glob("/mnt/playpen/mailwoman-data/wof/repos/whosonfirst-data/whosonfirst-data-admin-*/data")) + \
               ["/mnt/playpen/mailwoman-data/wof/repos/whosonfirst-data-admin-us/data"]
_gcache = {}
def geom_for_id(wid):
    if wid in _gcache: return _gcache[wid]
    s = str(int(wid)); chunks = [s[i:i+3] for i in range(0, len(s), 3)]
    rel = "/".join(chunks) + f"/{s}.geojson"
    g = None
    for root in _admin_roots:
        fp = os.path.join(root, rel)
        if os.path.exists(fp):
            try: g = json.load(open(fp)).get("geometry")
            except Exception: g = None
            break
    _gcache[wid] = g; return g

# ---- run the probe over the DE sample ----
rows = [json.loads(l) for l in open(SAMPLE) if l.strip()]
ov = collections.Counter(); by = collections.defaultdict(collections.Counter)
for r in rows:
    st = r.get("state") or "??"
    ov["n"] += 1; by[st]["n"] += 1
    glon, glat = r["lon"], r["lat"]
    # ground truth: which DE locality actually contains the gold point
    truth = pip_locality(glon, glat)
    if truth: ov["truth"] += 1; by[st]["truth"] += 1
    truth_id = truth[0] if truth else None
    # name signal: is the gold point inside the RESOLVER's chosen locality polygon? (== #273)
    nlid = dump.get(r["input"])
    ngeom = geom_for_id(nlid) if nlid else None
    name_ok = ngeom is not None and in_geom(glon, glat, ngeom)
    if name_ok: ov["name"] += 1; by[st]["name"] += 1
    pc = (r.get("expected") or {}).get("postcode")
    cen = pc_centroid.get(pc) if pc else None
    if not cen:
        if name_ok: ov["hybrid"] += 1; by[st]["hybrid"] += 1
        continue
    ov["has_pc"] += 1; by[st]["has_pc"] += 1
    cand = pip_locality(cen[1], cen[0])  # cen=(lat,lon) -> pip(lon,lat)
    # coordinate-first containment: does the gold point fall inside the centroid-PIP'd locality?
    cf_ok = cand is not None and truth_id is not None and cand[0] == truth_id
    if cf_ok: ov["cf"] += 1; by[st]["cf"] += 1
    # HYBRID ceiling: name signal OR coordinate signal lands the true locality
    if name_ok or cf_ok: ov["hybrid"] += 1; by[st]["hybrid"] += 1

def line(label, c):
    n = c["n"]
    if not n: return f"  {label}: n=0"
    pc = lambda k: f"{100*c[k]/n:.1f}%"
    return f"  {label:<10} n={n:<5} name={pc('name'):<7} coord-first={pc('cf'):<7} HYBRID(name OR coord)={pc('hybrid')}"

print("\n=== Resolver containment by signal (gold point inside the chosen locality) ===")
print(line("OVERALL", ov))
for st in sorted(by): print(line(st, by[st]))
print("\n  name = resolver's current name-match resolution; coord-first = postcode centroid -> PIP locality;")
print("  HYBRID = either signal lands the true locality (the soft-scoring ceiling).")
