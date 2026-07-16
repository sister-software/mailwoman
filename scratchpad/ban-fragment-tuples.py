"""Extract (street, locality, postcode) tuples from BAN for the `fr-fragment` shard recipe (#727 T2).

BAN's street-centroid DB is the Tier-A register: 2.2M rows, 1.02M distinct street surfaces, 32.5K
communes, Licence Ouverte (permissive — the model stays clean of ODbL, unlike the OSM rooftop shards).

Quality filters, each with a reason:
  point_count >= 3      a 1-point "street" in BAN is usually a lieu-dit or a data artifact
  no leading quote      BAN carries literal-quoted surfaces ('"Les Bisets" rue Nationale')
  6 <= len <= 48        drops fragments and run-on descriptions
  designator-led        the failing class IS the designator-led street; a bare nom_voie is a
                        different problem and would dilute the signal

Deduplicated by normalized surface, so one street contributes one tuple no matter how many communes
carry it. The recipe applies the eval-set exclusion itself (--exclude-surfaces) — the redundancy is
deliberate: the split is the one thing that cannot be checked after the fact.

SAMPLING: the candidate pool is collected in full and THEN sampled with a fixed seed. `ORDER BY
street_norm LIMIT n` looks equivalent and is not — it walks the register alphabetically and returns
120K rows that all begin with "Allee". A shard built that way teaches one designator.

Run from repo root:
    python3 scratchpad/ban-fragment-tuples.py --limit 120000 --out /tmp/ban-fr-tuples.jsonl
"""

import argparse
import json
import random
import re
import sqlite3
import unicodedata

DB = "/mnt/playpen/mailwoman-data/ban/street-centroids-fr.db"
DESIGNATORS = {
    "rue", "avenue", "boulevard", "place", "chemin", "impasse", "allee", "route", "quai", "cours",
    "square", "villa", "passage", "esplanade", "sentier", "voie", "rond-point", "traverse", "montee",
    "descente", "faubourg", "promenade", "parvis", "mail", "clos", "hameau", "lotissement", "residence",
}


DATEISH = re.compile(
    r"\b(1[0-9]|20)\d{2}\b|\b\d{1,2}\s+(janvier|f[\u00e9e]vrier|mars|avril|mai|juin|juillet|ao[\u00fbu]t|septembre|octobre|novembre|d[\u00e9e]cembre)\b",
    re.I,
)


def norm(s: str) -> str:
    s = "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", s).lower().strip()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=120_000)
    ap.add_argument("--out", default="/tmp/ban-fr-tuples.jsonl")
    ap.add_argument("--db", default=DB)
    ap.add_argument("--seed", type=int, default=727)
    args = ap.parse_args()

    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    q = """
        select street_raw, locality_base, postcode
        from street_centroid
        where point_count >= 3 and street_raw not like '"%' and length(street_raw) between 6 and 48
        order by street_norm
    """

    seen: set[str] = set()
    pool: list[dict] = []
    scanned = 0

    for raw, locality, postcode in conn.execute(q):
        scanned += 1
        raw = (raw or "").strip()
        if not raw or "  " in raw:
            continue
        key = norm(raw)
        if key in seen:
            continue
        first = key.split(" ")[0]
        if first not in DESIGNATORS:
            continue
        seen.add(key)
        pool.append(
            {"street": raw, "locality": (locality or "").strip(), "postcode": (postcode or "").strip()}
        )

    # OVERSAMPLE THE RARE TARGETS. Proportional sampling starves exactly the classes that need the
    # most help: date-name streets are ~0.2% of the register but the WORST cell on the fragment board
    # (0.055). A proportional 120K draw yields ~124 training rows for it — not a lesson, a rounding
    # error. So take every date-name surface available and sample the rest around them.
    rng = random.Random(args.seed)
    dated = [t for t in pool if DATEISH.search(t["street"])]
    rest = [t for t in pool if not DATEISH.search(t["street"])]
    take_rest = max(0, args.limit - len(dated))
    chosen = dated + rng.sample(rest, min(take_rest, len(rest)))
    chosen.sort(key=lambda t: norm(t["street"]))  # stable on disk; the SAMPLE is what spreads

    with open(args.out, "w", encoding="utf-8") as fh:
        for tuple_ in chosen:
            fh.write(json.dumps(tuple_, ensure_ascii=False) + "\n")

    from collections import Counter

    designators = Counter(norm(t["street"]).split(" ")[0] for t in chosen)
    print(f"scanned {scanned:,} rows -> pool {len(pool):,} distinct designator-led surfaces")
    print(f"sampled {len(chosen):,} (seed {args.seed}) -> {args.out}")
    print("  designator spread:", ", ".join(f"{d}:{n}" for d, n in designators.most_common(8)))
    print(f"  date-name surfaces: {len(dated):,} (ALL of them — oversampled, the board's worst cell)")


if __name__ == "__main__":
    main()
