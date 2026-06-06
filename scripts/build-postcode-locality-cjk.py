#!/usr/bin/env python3
"""Build a CJK postcode -> WOF locality table by AUTHORITATIVE NAME-MATCH (#292, Direction E).

WOF admin geometry in CJK (JP/KR/TW) is point-based at the municipality/locality level — there are no
municipality POLYGONS — so the European point-in-polygon coordinate-first build (build-postcode-locality.py)
is structurally inapplicable. This is the CJK substitute:

  postcode --(national postal authority)--> municipality NAME (romanized)
  postcode --(GeoNames)--> point
  municipality name + point --(cross-placetype name+proximity match)--> WOF place id

The match searches ALL the municipality-ish WOF placetypes (locality + county + localadmin + borough),
because CJK municipalities are split across them (regular cities -> locality, wards -> county/localadmin,
Tokyo special wards -> borough). Matching a single placetype was the 52/60% trap; cross-placetype is 94.3%.

Output is the standard `postcode_locality` table, so the existing `postcode_area_resolution` resolver
strategy consumes it unchanged (is_containing=1 for the name-matched municipality). Build-from-source:
the authoritative names come from the national postal file (JP = KEN_ALL, Japan Post), points from
GeoNames (already an in-project source for DE/ES/IT/NL); both are source material, not prebuilt dumps.

Usage (JP):
  python3 scripts/build-postcode-locality-cjk.py --country JP \
    --postal-names /mnt/playpen/mailwoman-data/KEN_ALL_ROME/KEN_ALL_ROME.CSV \
    --geonames /mnt/playpen/mailwoman-data/geonames/JP.txt \
    --admin-db /mnt/playpen/mailwoman-data/wof/admin-global-priority.db \
    --output /mnt/playpen/mailwoman-data/wof/postcode-locality-jp.db
"""
import argparse, collections, datetime, json, math, re, sqlite3, unicodedata, codecs

MATCH_RADIUS_KM = 15.0
NEARBY_KEEP = 2  # extra non-containing candidates kept for the soft-score set
PLACETYPES = ("locality", "county", "localadmin", "borough")
SUFFIX = re.compile(r"(shi|ku|cho|machi|gun|ken|fu|to|son|mura|ward|si|gu|dong|eup|myeon|ri)$")


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r"[\s\-]", "", s)


def name_matches(wof_name: str, postal_muni: str) -> bool:
    """The WOF place name (suffix-stripped) appears as a token in the authoritative municipality string
    (which carries city+ward, e.g. 'SAPPORO SHI CHUO KU')."""
    nw = SUFFIX.sub("", norm(wof_name))
    return len(nw) >= 2 and nw in norm(postal_muni)


def haversine(a, b, c, d):
    R = 6371.0
    p1, p2, dp, dl = math.radians(a), math.radians(c), math.radians(c - a), math.radians(d - b)
    return 2 * R * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


def load_kenall(path: str) -> dict:
    """JP KEN_ALL_ROME (CP932): col0=postcode(7-digit), col5=municipality romaji. -> {NNN-NNNN: muni}."""
    out = {}
    for line in codecs.open(path, encoding="cp932"):
        f = [c.strip('"') for c in line.rstrip("\r\n").split(",")]
        if len(f) >= 6 and len(f[0]) == 7 and f[0].isdigit():
            out[f"{f[0][:3]}-{f[0][3:]}"] = f[5]
    return out


def load_geonames_points(path: str) -> dict:
    out = {}
    for line in open(path, encoding="utf-8"):
        f = line.rstrip("\n").split("\t")
        if len(f) > 10 and f[1]:
            try:
                out[f[1]] = (float(f[9]), float(f[10]))  # postcode (NNN-NNNN) -> lat, lon
            except ValueError:
                pass
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--country", required=True)
    ap.add_argument("--postal-names", required=True, help="national postal file (JP=KEN_ALL_ROME.CSV)")
    ap.add_argument("--geonames", required=True)
    ap.add_argument("--admin-db", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    postal = load_kenall(args.postal_names) if args.country == "JP" else {}
    if not postal:
        raise SystemExit(f"no postal names loaded for {args.country} (only KEN_ALL/JP wired so far)")
    points = load_geonames_points(args.geonames)

    admin = sqlite3.connect(args.admin_db)
    ph = ",".join("?" for _ in PLACETYPES)
    places = admin.execute(
        f"SELECT id,name,latitude,longitude FROM spr WHERE country=? AND placetype IN ({ph}) "
        f"AND latitude IS NOT NULL AND NOT (latitude=0 AND longitude=0)",
        (args.country, *PLACETYPES),
    ).fetchall()
    grid = collections.defaultdict(list)
    for pid, nm, la, lo in places:
        grid[(round(lo * 2), round(la * 2))].append((pid, nm, la, lo))

    def nearby(lat, lon):
        cx, cy, out = round(lon * 2), round(lat * 2), []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for pid, nm, la, lo in grid.get((cx + dx, cy + dy), []):
                    d = haversine(lat, lon, la, lo)
                    if d <= MATCH_RADIUS_KM:
                        out.append((d, pid, nm))
        out.sort()
        return out

    db = sqlite3.connect(args.output)
    db.execute("DROP TABLE IF EXISTS postcode_locality")
    db.execute(
        "CREATE TABLE postcode_locality (postcode TEXT NOT NULL, country TEXT NOT NULL, locality_id INTEGER NOT NULL,"
        " locality_name TEXT NOT NULL, aliases TEXT, distance_km REAL NOT NULL, is_containing INTEGER NOT NULL)"
    )
    ins = db.prepare("INSERT INTO postcode_locality VALUES (?,?,?,?,?,?,?)") if hasattr(db, "prepare") else None
    rows = []
    matched = 0
    keys = [k for k in postal if k in points]
    for pc in keys:
        muni = postal[pc]
        lat, lon = points[pc]
        cands = nearby(lat, lon)
        if not cands:
            continue
        hit = next(((d, pid, nm) for (d, pid, nm) in cands if name_matches(nm, muni)), None)
        if hit:
            matched += 1
            d, pid, nm = hit
            rows.append((pc, args.country, pid, nm, muni, round(d, 3), 1))
            for d2, pid2, nm2 in cands[:NEARBY_KEEP]:
                if pid2 != pid:
                    rows.append((pc, args.country, pid2, nm2, muni, round(d2, 3), 0))
        else:  # no authoritative name match nearby -> nearest place as a weak candidate
            d, pid, nm = cands[0]
            rows.append((pc, args.country, pid, nm, muni, round(d, 3), 0))
    db.executemany("INSERT INTO postcode_locality VALUES (?,?,?,?,?,?,?)", rows)
    db.execute("CREATE INDEX postcode_locality_by_pc ON postcode_locality(postcode, country)")

    db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    meta = {
        "name": "mailwoman-postcode-locality-cjk",
        "description": "CJK postcode -> WOF locality via authoritative-name + proximity match (no polygons)",
        "method": "national-postal-authority municipality NAME + GeoNames point -> cross-placetype WOF match",
        "source": f"{args.country}: KEN_ALL_ROME (Japan Post, romanized) + GeoNames postal points; built from source",
        "country": args.country,
        "postcodes_total": str(len(keys)),
        "postcodes_matched": str(matched),
        "match_rate": f"{100*matched/len(keys):.1f}%",
        "built_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    }
    db.executemany("INSERT OR REPLACE INTO meta VALUES (?,?)", list(meta.items()))
    db.commit()
    db.execute("PRAGMA journal_mode=DELETE")
    db.execute("ANALYZE")
    ok = db.execute("PRAGMA integrity_check").fetchone()[0]
    if ok != "ok":
        raise SystemExit(f"integrity_check failed: {ok}")
    db.commit()
    db.execute("VACUUM")
    db.close()
    print(f"{args.country}: {len(keys):,} postcodes (KEN_ALL∩GeoNames), {matched:,} name-matched "
          f"({100*matched/len(keys):.1f}%), {len(rows):,} rows -> {args.output}")


if __name__ == "__main__":
    main()
