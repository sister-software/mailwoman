#!/usr/bin/env python3
"""PIP-containment metric (coordinate-first plan, #273).

Reads the `--out-resolved` dump from oa-resolver-eval.ts (per row: gold OA lat/lon + the neural-resolved
locality's WOF id + the old name-match flag) and tests the NON-GAMEABLE truth: does the gold point lie
INSIDE the polygon of the resolved WOF locality? This is name-surface-independent — it rewards a
geographically-correct resolve even when WOF's canonical name ("Plauen") differs from OA's gold
("Plauen Vogtl"). Compares containment-accuracy vs the old name-match on the SAME rows.

Usage: python3 scripts/eval/pip-containment.py /tmp/resolved-de.json
"""
import json, sys, glob, os, collections

WOF_REPOS = "/mnt/playpen/mailwoman-data/wof/repos"
ADMIN_ROOTS = sorted(glob.glob(f"{WOF_REPOS}/whosonfirst-data/whosonfirst-data-admin-*/data")) + \
              [f"{WOF_REPOS}/whosonfirst-data-admin-us/data"]

_geom_cache = {}

def geom_for_id(wof_id):
    if wof_id in _geom_cache:
        return _geom_cache[wof_id]
    s = str(int(wof_id))
    # WOF path: split the id into 3-char chunks (last chunk is the remainder).
    chunks, i = [], 0
    while i < len(s):
        chunks.append(s[i:i+3]); i += 3
    rel = "/".join(chunks) + f"/{s}.geojson"
    geom = None
    for root in ADMIN_ROOTS:
        fp = os.path.join(root, rel)
        if os.path.exists(fp):
            try:
                geom = json.load(open(fp)).get("geometry")
            except Exception:
                geom = None
            break
    _geom_cache[wof_id] = geom
    return geom

def in_ring(x, y, ring):
    inside, n, j = False, len(ring), len(ring) - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside

def in_polygon(x, y, poly):  # poly = [outer, hole1, ...] — even-odd handles holes
    c = False
    for ring in poly:
        if in_ring(x, y, ring):
            c = not c
    return c

def contains(geom, lon, lat):
    if not geom:
        return None  # no polygon available
    t = geom.get("type")
    if t == "Polygon":
        return in_polygon(lon, lat, geom["coordinates"])
    if t == "MultiPolygon":
        return any(in_polygon(lon, lat, p) for p in geom["coordinates"])
    return None  # Point geometry etc. — can't contain

# --- arg parsing: <resolved.json> [--label NAME] [--json OUT] ---------------
args = sys.argv[1:]
src = None
label_arg = None
json_out = None
i = 0
while i < len(args):
    a = args[i]
    if a == "--label":
        label_arg = args[i + 1]; i += 2
    elif a == "--json":
        json_out = args[i + 1]; i += 2
    else:
        src = a; i += 1
if not src:
    print("usage: pip-containment.py <resolved.json> [--label NAME] [--json OUT]", file=sys.stderr)
    sys.exit(2)

rows = json.load(open(src))
overall = collections.Counter()
by_state = collections.defaultdict(collections.Counter)
artifact_examples = []
no_poly = 0
for r in rows:
    st = r.get("state") or "??"
    overall["n"] += 1; by_state[st]["n"] += 1
    name_ok = bool(r.get("nameMatch"))
    if name_ok:
        overall["name"] += 1; by_state[st]["name"] += 1
    lid = r.get("neuralLocId")
    contained = contains(geom_for_id(lid), r["lon"], r["lat"]) if lid else None
    if contained is not None:  # a polygon existed and was tested (True or False)
        overall["poly"] += 1; by_state[st]["poly"] += 1
    elif lid:
        no_poly += 1
    if contained:
        overall["pip"] += 1; by_state[st]["pip"] += 1
        if not name_ok and len(artifact_examples) < 12:
            artifact_examples.append(f'  "{r["input"]}"  gold="{r.get("expectedLoc")}"  resolved="{r.get("neuralLoc")}"')

def pct(num, den):
    return f"{100*num/den:.1f}%" if den else "—"

def line(label, c):
    n = c["n"]
    if not n:
        return f"  {label}: n=0"
    # PIP-containment is reported two ways: over ALL rows (strict) and over rows
    # that HAVE a polygon (coverage-adjusted), since WOF point-geometry localities
    # can never PIP-contain and would otherwise count as silent failures.
    return (
        f"  {label:<10} n={n:<5} name-match={pct(c['name'],n):<7} "
        f"PIP-containment={pct(c['pip'],n):<7} delta={100*(c['pip']-c['name'])/n:+.1f}pp  "
        f"PIP/poly={pct(c['pip'],c['poly']):<7} poly-cov={pct(c['poly'],n)}"
    )

print(f"\n=== PIP-containment vs name-match ({src}{' · '+label_arg if label_arg else ''}) ===")
print(line("OVERALL", overall))
for st in sorted(by_state):
    print(line(st, by_state[st]))
print(f"\n  rows resolved-but-polygon-missing: {no_poly}")
print(f"\nMETRIC-ARTIFACT cases (name-match FAILED but gold point IS inside the resolved locality):")
for e in artifact_examples:
    print(e)

if json_out:
    n = overall["n"]
    summary = {
        "label": label_arg,
        "source": src,
        "n": n,
        "name_match": overall["name"] / n if n else None,
        "pip_all": overall["pip"] / n if n else None,
        "pip_poly": overall["pip"] / overall["poly"] if overall["poly"] else None,
        "poly_coverage": overall["poly"] / n if n else None,
        "no_polygon": no_poly,
    }
    with open(json_out, "w") as f:
        json.dump(summary, f, indent=2)
    print(f"\nwrote summary → {json_out}", file=sys.stderr)
