#!/usr/bin/env python3
"""gen-wof-bootstrap.py — WOF-bootstrap end-to-end eval set (Direction C, Phase 1).

Samples real Who's-On-First US places (localities + postcodes), renders them into
address strings (canonical AND rule-defeating perturbations), and labels each with
the source WOF id + centroid coords. Running these through parse->resolve and
checking the resolved WOF id is the first END-TO-END "address -> correct place"
benchmark (the resolver has unit tests but no whole-stack accuracy number).

WHY WOF-sourced: it's independent of our Pelias-lineage suite, and the resolver's
142k-candidate ambiguity (real Springfield-style conflicts) makes round-tripping
non-trivial. The synthetic house/street don't affect the label (the resolver is
admin-level), but make the parse realistic + exercise the street-overspan failure.
Caveat: these are SYNTHETIC address strings; the OpenAddresses track adds an
independent REAL-address coordinate-error signal.

Hierarchy-tolerant label: a locality row accepts {locality_id, region_id} (a
returned region for a city is a reasonable approximation); a postcode row accepts
{postcode_id, region_id}.

Output JSONL row:
  {input, expected_id, acceptable_ids[], specificity, lat, lon,
   expected:{locality?,region?,postcode?}, template, perturb, source}

Usage:
  python3 scripts/eval/gen-wof-bootstrap.py \
    --admin /mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-latest.db \
    --postcode /mnt/playpen/mailwoman-data/wof/whosonfirst-data-postalcode-us-latest.db \
    --per-region 8 --postcodes 120 --out /tmp/wof-bootstrap/eval.jsonl
"""
import argparse
import json
import random
import re
import sqlite3
from pathlib import Path

# state/territory name -> USPS abbreviation (real addresses use the abbrev).
STATE_ABBREV = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA",
    "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE", "Florida": "FL", "Georgia": "GA",
    "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA",
    "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD",
    "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS",
    "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH",
    "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC",
    "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA",
    "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", "Tennessee": "TN",
    "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA",
    "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY",
    "District of Columbia": "DC", "Puerto Rico": "PR",
}

STREETS = ["Main St", "Oak Ave", "Maple Dr", "Park Ave", "1st St", "2nd Ave", "Elm St",
           "Washington Blvd", "Lake Rd", "Hill St", "Cedar Ln", "Pine St", "Sunset Blvd",
           "Broadway", "Market St", "Church St", "5th Ave", "Highland Ave", "Center St"]

ZIP_RE = re.compile(r"^\d{5}$")


def glue(s: str) -> str:
    """Collapse the space between a 2-letter region + adjacent number ('NY 10025' -> 'NY10025')."""
    return re.sub(r"\b([A-Z]{2})\s+(\d{3,5})\b", r"\1\2", s)


# (name, fn) — canonical is the identity; the rest defeat rule cues (cf. perturb-golden.ts).
PERTURBATIONS = [
    ("canonical", lambda s: s),
    ("lowercase", lambda s: s.lower()),
    ("nocomma", lambda s: s.replace(",", "")),
    ("glued", glue),
]


def load_regions(con: sqlite3.Connection) -> dict[int, str]:
    return {rid: name for rid, name in
            con.execute("SELECT id, name FROM spr WHERE placetype='region'").fetchall()}


def sample_localities(con, per_region: int, rng: random.Random):
    """Return [(loc_id, name, lat, lon, region_id)] — per-region seeded sample for state diversity."""
    rows = con.execute(
        "SELECT s.id, s.name, s.latitude, s.longitude, a.ancestor_id "
        "FROM spr s JOIN ancestors a ON a.id = s.id AND a.ancestor_placetype='region' "
        "WHERE s.placetype='locality' AND s.country='US' AND s.latitude != 0 AND s.is_current != 0 "
        "ORDER BY s.id"  # deterministic order; rng.sample picks reproducibly
    ).fetchall()
    by_region: dict[int, list] = {}
    for r in rows:
        by_region.setdefault(r[4], []).append(r)
    out = []
    for rid, group in by_region.items():
        out.extend(rng.sample(group, min(per_region, len(group))))
    return out


def sample_postcodes(con, n: int, rng: random.Random):
    rows = con.execute(
        "SELECT s.id, s.name, s.latitude, s.longitude, a.ancestor_id "
        "FROM spr s JOIN ancestors a ON a.id = s.id AND a.ancestor_placetype='region' "
        "WHERE s.placetype='postalcode' AND s.latitude != 0 AND s.is_current != 0 "
        "ORDER BY s.id"
    ).fetchall()
    rows = [r for r in rows if ZIP_RE.match(str(r[1] or ""))]
    return rng.sample(rows, min(n, len(rows)))


def main():
    ap = argparse.ArgumentParser()
    # Canonical custom DB (never the off-the-shelf dumps — see feedback-custom-wof-db-only memory).
    ap.add_argument("--admin", default="/mnt/playpen/mailwoman-data/wof/admin-global-priority.db")
    # Custom US postcode shard (built via build-unified-wof --placetypes postalcode). Note: its
    # `ancestors` are self-only (parents live in the admin DB), so the region for a "region postcode"
    # template needs a cross-DB lookup — until then the postcode family emits bare-ZIP cases. Set to
    # "" to skip postcodes entirely.
    ap.add_argument("--postcode", default="/mnt/playpen/mailwoman-data/wof/postalcode-us.db")
    ap.add_argument("--per-region", type=int, default=8)
    ap.add_argument("--postcodes", type=int, default=120)
    ap.add_argument("--seed", type=int, default=20260530)
    ap.add_argument("--out", default="/tmp/wof-bootstrap/eval.jsonl")
    args = ap.parse_args()
    rng = random.Random(args.seed)

    ca = sqlite3.connect(f"file:{args.admin}?mode=ro", uri=True)
    regions = load_regions(ca)
    locs = sample_localities(ca, args.per_region, rng)
    ca.close()
    # Postcodes are opt-in (the custom build is admin-only). Skip the postcode family unless a
    # postcode DB is explicitly provided.
    pcs = []
    if args.postcode and Path(args.postcode).exists():
        cp = sqlite3.connect(f"file:{args.postcode}?mode=ro", uri=True)
        pcs = sample_postcodes(cp, args.postcodes, rng)
        cp.close()

    rows = []

    def emit(base_string, perturb_targets, **label):
        # perturb_targets: which perturbations to apply (some are no-ops for some templates)
        for pname, fn in PERTURBATIONS:
            if pname not in perturb_targets:
                continue
            s = fn(base_string)
            if pname != "canonical" and s == base_string:
                continue  # perturbation was a no-op for this string
            rows.append({**label, "input": s, "perturb": pname})

    for loc_id, name, lat, lon, region_id in locs:
        region_name = regions.get(region_id)
        if not region_name:
            continue
        abbr = STATE_ABBREV.get(region_name, region_name)
        label = dict(expected_id=loc_id, acceptable_ids=[loc_id, region_id], specificity="locality",
                     lat=lat, lon=lon, expected={"locality": name, "region": abbr}, source="wof-bootstrap")
        # full (synthetic house+street) and no-street; comma/lowercase apply, glue doesn't (no ZIP)
        house = rng.randint(1, 9999)
        street = rng.choice(STREETS)
        emit(f"{house} {street}, {name}, {abbr}", ["canonical", "lowercase", "nocomma"],
             template="full", **label)
        emit(f"{name}, {abbr}", ["canonical", "lowercase", "nocomma"], template="no_street", **label)

    for pc_id, zipc, lat, lon, region_id in pcs:
        region_name = regions.get(region_id)
        abbr = STATE_ABBREV.get(region_name, region_name) if region_name else None
        label = dict(expected_id=pc_id, acceptable_ids=[pc_id] + ([region_id] if region_name else []),
                     specificity="postcode", lat=lat, lon=lon,
                     expected={"postcode": zipc, **({"region": abbr} if abbr else {})}, source="wof-bootstrap")
        if abbr:
            # region+postcode exercises the glue perturbation ("NY 10025" -> "NY10025")
            emit(f"{abbr} {zipc}", ["canonical", "lowercase", "glued"], template="region_postcode", **label)
        emit(f"{zipc}", ["canonical"], template="postcode", **label)

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    from collections import Counter
    print(f"wrote {len(rows)} rows -> {args.out}")
    print("by specificity:", dict(Counter(r["specificity"] for r in rows)))
    print("by template:", dict(Counter(r["template"] for r in rows)))
    print("by perturb:", dict(Counter(r["perturb"] for r in rows)))
    print(f"localities sampled: {len(locs)} across {len(set(l[4] for l in locs))} regions; postcodes: {len(pcs)}")


if __name__ == "__main__":
    main()
