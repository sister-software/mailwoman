#!/usr/bin/env python3
"""Build a KR postcode -> WOF locality table by POINT-PRIMARY match (#293, Direction E / CJK arena).

This is the South-Korea sibling of `build-postcode-locality-cjk.py` (Japan). It emits the SAME
`postcode_locality` table, so the existing `postcode_area_resolution` resolver strategy consumes it
unchanged — that is the whole point of the CJK arena: ONE strategy, many builds. But KR's data shape is
the INVERSE of Japan's, so the build is inverted too:

  Japan (name-primary):  postcode --KEN_ALL--> municipality NAME (romaji) ; GeoNames --> point ;
                         match NAME (+ proximity tiebreak) against romanized `spr.name`.  -> 94.9%
  Korea (point-primary): GeoNames postal file ALREADY carries postcode -> (place_name, admin1, lat, lon)
                         in one source. `spr.name` is romanized, but the WOF `names` table carries Hangul
                         (`kor` + Hangul-bearing `und`) variants. So we resolve by NEAREST locality POINT
                         (always available, sub-km dense) and use the Hangul name as an authoritative
                         CONFIRMATION signal where it exists.

Why point-primary for KR (the measured reality, 2026-06-05):
  - WOF admin-kr has only region(province, ~17) and locality(~21k); there is NO clean municipality
    (시군구) placetype, and `parent_id` chains don't link locality->region in the per-country DB.
  - The locality layer is ri/village-level — denser (p50 0.96 km to the nearest) than the postal
    place_name's eup/myeon/dong granularity, so point-nearest is spatially excellent but often lands on a
    finer, differently-named unit (name concordance only ~9% — a granularity mismatch, not a wrong place).
  - Hangul name-match (kor + und) covers ~56% of postcodes; the dominant miss bucket is 구 (urban
    districts: Seoul/Busan), which WOF KR does not carry as named localities. This is a WOF-data ceiling,
    not an architecture limit. A higher-coverage KR build needs a better admin source (Juso / 도로명주소,
    currently key-walled) — tracked as the #293 follow-up.

Tiering (same schema/semantics as the JP builder):
  - is_containing=1  : Hangul name-confirmed locality (the precise tier; correct granularity, authoritative)
  - is_containing=0  : point-nearest fallback (province + coordinate are right; the unit may be finer/renamed)

The province (admin1 -> WOF region, Hangul-exact, 100%) is recorded in `meta` as the reliable coarse anchor.

Build-from-source: GeoNames postal KR (already an in-project source for DE/ES/IT/NL) + our custom WOF
admin-kr.db (built from the whosonfirst-data-admin-kr repo, never a prebuilt geocode.earth dump).

Usage:
  python3 scripts/build-postcode-locality-kr.py \
    --geonames /mnt/playpen/mailwoman-data/geonames/KR.txt \
    --admin-db /mnt/playpen/mailwoman-data/wof/dbs-per-country/admin-kr.db \
    --output   /mnt/playpen/mailwoman-data/wof/postcode-locality-kr.db
"""
import argparse, collections, datetime, math, re, sqlite3, unicodedata

MATCH_RADIUS_KM = 20.0  # KR postcode points sit p50 ~1 km from the nearest locality; 20 km is a safe net
HANGUL = re.compile(r"[가-힣]")
# Korean administrative suffixes, stripped to a bare stem so 추자면 ~ 추자, 강남구 ~ 강남, etc.
SUFFIX = re.compile(r"(특별자치도|특별자치시|광역시|특별시|면|동|읍|시|군|구|리)$")


def norm(s: str) -> str:
    return re.sub(r"[\s\-]", "", unicodedata.normalize("NFKC", s or "")).lower()


def bare(s: str) -> str:
    return SUFFIX.sub("", norm(s))


def haversine(a, b, c, d):
    R = 6371.0
    p1, p2, dp, dl = math.radians(a), math.radians(c), math.radians(c - a), math.radians(d - b)
    return 2 * R * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--geonames", required=True, help="GeoNames postal KR.txt (12-col: pc, place, admin1, lat, lon)")
    ap.add_argument("--admin-db", required=True, help="custom WOF admin-kr.db (spr + names)")
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    admin = sqlite3.connect(args.admin_db)

    # Locality point index + id->name (romanized spr.name, for the human-readable row label).
    loc = admin.execute(
        "SELECT id,name,latitude,longitude FROM spr WHERE placetype='locality' AND (latitude!=0 OR longitude!=0)"
    ).fetchall()
    xy = {pid: (la, lo) for pid, _nm, la, lo in loc}
    spr_name = {pid: nm for pid, nm, _la, _lo in loc}
    grid = collections.defaultdict(list)
    for pid, _nm, la, lo in loc:
        grid[(round(lo * 2), round(la * 2))].append((pid, la, lo))

    # Hangul locality-name index (kor + Hangul-bearing und): bare-stem -> set(ids).
    name_idx = collections.defaultdict(set)
    for lang in ("kor", "und"):
        for nid, nm in admin.execute("SELECT id,name FROM names WHERE language=? AND placetype='locality'", (lang,)):
            if nid in xy and nm and HANGUL.search(nm):
                name_idx[bare(nm)].add(nid)

    # Province (admin1) anchor: Hangul region name -> region id (records coarse-anchor coverage in meta).
    region_idx = {}
    for rid, nm in admin.execute(
        "SELECT s.id,n.name FROM spr s JOIN names n ON n.id=s.id AND n.language IN ('kor','und') WHERE s.placetype='region'"
    ):
        if nm and HANGUL.search(nm):
            region_idx[norm(nm)] = rid
            region_idx[bare(nm)] = rid

    def nearby(lat, lon):
        """All localities within MATCH_RADIUS_KM, sorted nearest-first. Korean place names repeat heavily
        across the country (homonymous villages), so a Hangul name-match MUST be constrained to nearby
        candidates — matching globally then taking the nearest homonym lands hundreds of km away."""
        cx, cy, out = round(lon * 2), round(lat * 2), []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for pid, la, lo in grid.get((cx + dx, cy + dy), []):
                    d = haversine(lat, lon, la, lo)
                    if d <= MATCH_RADIUS_KM:
                        out.append((d, pid))
        out.sort()
        return out

    # GeoNames postal KR: group by postcode (first row wins; multi-row postcodes cluster tightly).
    postal = collections.OrderedDict()
    for line in open(args.geonames, encoding="utf-8"):
        f = line.rstrip("\n").split("\t")
        if len(f) > 10 and f[1]:
            try:
                postal.setdefault(f[1], (f[2], f[3], float(f[9]), float(f[10])))  # pc -> (place, admin1, lat, lon)
            except ValueError:
                pass

    db = sqlite3.connect(args.output)
    db.execute("DROP TABLE IF EXISTS postcode_locality")
    db.execute(
        "CREATE TABLE postcode_locality (postcode TEXT NOT NULL, country TEXT NOT NULL, locality_id INTEGER NOT NULL,"
        " locality_name TEXT NOT NULL, aliases TEXT, distance_km REAL NOT NULL, is_containing INTEGER NOT NULL)"
    )

    rows = []
    resolved = name_confirmed = province_ok = 0
    dists = []
    for pc, (place, admin1, lat, lon) in postal.items():
        nb = nearby(lat, lon)
        if not nb:
            continue
        resolved += 1
        d0, pid0 = nb[0]  # point-nearest
        dists.append(d0)
        if norm(admin1) in region_idx or bare(admin1) in region_idx:
            province_ok += 1
        # Hangul name confirmation: a name-matched locality that is ALSO nearby (two signals agreeing —
        # the same proximity-constrained match the JP builder uses). is_containing=1 marks the precise tier.
        name_ids = name_idx.get(bare(place), set())
        named = next(((d, pid) for d, pid in nb if pid in name_ids), None)
        if named:
            name_confirmed += 1
            nd, npid = named
            rows.append((pc, "KR", npid, spr_name.get(npid, ""), place, round(nd, 3), 1))
            if npid != pid0:  # keep the point-nearest as a weak alternate
                rows.append((pc, "KR", pid0, spr_name.get(pid0, ""), place, round(d0, 3), 0))
        else:
            rows.append((pc, "KR", pid0, spr_name.get(pid0, ""), place, round(d0, 3), 0))

    db.executemany("INSERT INTO postcode_locality VALUES (?,?,?,?,?,?,?)", rows)
    db.execute("CREATE INDEX postcode_locality_by_pc ON postcode_locality(postcode, country)")

    dists.sort()
    p = lambda q: round(dists[int(len(dists) * q)], 3) if dists else 0.0
    total = len(postal)
    db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    meta = {
        "name": "mailwoman-postcode-locality-kr",
        "description": "KR postcode -> WOF locality via point-primary match (GeoNames postal point + Hangul name confirm)",
        "method": "point-primary: nearest WOF locality by GeoNames postal coordinate; Hangul (kor+und) name confirms the precise tier",
        "source": "KR: GeoNames postal KR.txt + custom WOF admin-kr.db (whosonfirst-data-admin-kr); built from source",
        "country": "KR",
        "postcodes_total": str(total),
        "postcodes_resolved": str(resolved),
        "resolve_rate": f"{100*resolved/total:.1f}%",
        "name_confirmed": str(name_confirmed),
        "name_confirm_rate": f"{100*name_confirmed/total:.1f}%",
        "province_match": f"{100*province_ok/total:.1f}%",
        "dist_km_p50": str(p(0.5)),
        "dist_km_p90": str(p(0.9)),
        "dist_km_p99": str(p(0.99)),
        "ceiling_note": "name tier capped by WOF KR Hangul-name coverage; dominant miss = 구 urban districts (Juso source walled, #293 follow-up)",
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
    print(
        f"KR: {total:,} postcodes, {resolved:,} resolved ({100*resolved/total:.1f}%), "
        f"{name_confirmed:,} name-confirmed ({100*name_confirmed/total:.1f}%), province {100*province_ok/total:.1f}%, "
        f"dist p50/p90/p99 = {p(0.5)}/{p(0.9)}/{p(0.99)} km, {len(rows):,} rows -> {args.output}"
    )


if __name__ == "__main__":
    main()
