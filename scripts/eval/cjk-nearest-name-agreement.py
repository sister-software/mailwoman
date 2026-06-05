#!/usr/bin/env python3
"""CJK nearest-point resolution + name-agreement metric (#292, Direction E).

WOF CJK admin geometry is POINT-based at the municipality/locality level (confirmed JP+KR+TW), so the
European PIP-into-polygons method is inapplicable. This is the CJK substitute: assign each postcode to
the NEAREST WOF place (point), and measure with a NAME-AGREEMENT metric (not PIP-containment) — does the
resolved WOF place's name agree with the postcode's independent municipality name?

Gold source: GeoNames postal (postcode -> placename/admin2 name + point). NON-CIRCULAR caveat: the point
drives the nearest-assignment and the NAME validates it, but when gold == GeoNames for both, the metric
chiefly measures cross-source NAME agreement — and it is confounded by WOF JP's inconsistent admin
modeling (designated-city wards: WOF resolves "Kita" = the correct Osaka ward, GeoNames labels it
"Osaka Shi", scored a miss). The authoritative fix is KEN_ALL (postcode->romanized municipality, matches
WOF romaji) — published but Japan Post blocks programmatic download. Until KEN_ALL lands, this metric
UNDERCOUNTS true resolution accuracy; treat the number as a floor.

Usage:
  python3 scripts/eval/cjk-nearest-name-agreement.py \
    --geonames /mnt/playpen/mailwoman-data/geonames/JP.txt --country JP \
    --admin-db /mnt/playpen/mailwoman-data/wof/admin-global-priority.db --placetype county --sample 3000
"""
import argparse, collections, math, random, re, sqlite3, unicodedata

SUFFIXES = re.compile(r"(shi|ku|cho|machi|ward|gun|ken|fu|to|son|mura|si|gun|do|gu|dong|eup|myeon|ri)$")


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[\s\-]", "", s)
    return SUFFIXES.sub("", s)


def agree(a: str, b: str) -> bool:
    na, nb = norm(a), norm(b)
    return bool(na and nb and (na == nb or na in nb or nb in na))


def haversine(a, b, c, d):
    R = 6371.0
    p1, p2, dp, dl = math.radians(a), math.radians(c), math.radians(c - a), math.radians(d - b)
    return 2 * R * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--geonames", required=True)
    ap.add_argument("--country", required=True)
    ap.add_argument("--admin-db", required=True)
    ap.add_argument("--placetype", default="county", help="WOF level to match (JP: county≈ward, locality≈town)")
    ap.add_argument("--sample", type=int, default=3000)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    db = sqlite3.connect(args.admin_db)
    pts = db.execute(
        "SELECT name, latitude, longitude FROM spr WHERE country=? AND placetype=? AND latitude IS NOT NULL",
        (args.country, args.placetype),
    ).fetchall()
    # 0.5deg grid for nearest-neighbour
    grid = collections.defaultdict(list)
    for nm, la, lo in pts:
        grid[(round(lo * 2), round(la * 2))].append((nm, la, lo))

    def nearest(lat, lon):
        best, bd, cx, cy = None, 1e9, round(lon * 2), round(lat * 2)
        for r in range(0, 6):
            for dx in range(-r, r + 1):
                for dy in range(-r, r + 1):
                    if max(abs(dx), abs(dy)) != r:
                        continue
                    for nm, la, lo in grid.get((cx + dx, cy + dy), []):
                        dd = haversine(lat, lon, la, lo)
                        if dd < bd:
                            bd, best = dd, nm
            if best and r >= 1:
                break
        return best, bd

    gold = []
    for line in open(args.geonames, encoding="utf-8"):
        f = line.rstrip("\n").split("\t")
        if len(f) > 10 and f[5]:
            try:
                gold.append((f[2], f[5], float(f[9]), float(f[10])))  # town, municipality, lat, lon
            except ValueError:
                pass
    random.seed(args.seed)
    sample = random.sample(gold, min(args.sample, len(gold)))

    agree_muni = agree_any = 0
    dists = []
    for town, muni, lat, lon in sample:
        nm, d = nearest(lat, lon)
        if nm is None:
            continue
        dists.append(d)
        if agree(nm, muni):
            agree_muni += 1
        if agree(nm, muni) or agree(nm, town):
            agree_any += 1
    n = len(sample)
    md = sorted(dists)[len(dists) // 2] if dists else 0
    print(f"{args.country} @ WOF {args.placetype}: name-agree(muni)={100*agree_muni/n:.1f}%  "
          f"agree(muni|town)={100*agree_any/n:.1f}%  median nearest dist={md:.1f}km  (n={n})")


if __name__ == "__main__":
    main()
