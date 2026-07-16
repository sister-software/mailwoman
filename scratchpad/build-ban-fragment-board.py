"""T1c — build the FR locale fragment board from BAN (Tier A).

Turns the per-class table from anecdote into evidence. The Paris fixture is n=63 with cells like
3/15, whose 95% CI is roughly 4-48% — not a measurement. This samples BAN (clean, national,
street-name complete) at ~400/class so each cell gets a usable interval.

Seven classes. Six positive (the operator's phenomenon taxonomy) and one NEGATIVE:

  bare-street            "Rue Montmartre"
  street-particle        "Rue de la Paix"
  street-housenumber     "12 Rue Montmartre"
  alnum-housenumber      "12 bis Rue Montmartre"
  date-name              "Rue du 11 Novembre 1918"
  admin-street-homonym   a street whose name-part IS a French commune
  bare-locality          "Saint-Jean-de-Luz"  <- expect NO street

KNOWN LIMITATION on the negative class: BAN's sharded DBs keep only `locality_norm` /
`locality_base` — the raw commune surface is not retained anywhere, so these inputs are
accent-stripped (`Amelie-les-Bains-Palalda`, not `Amélie-les-Bains-Palalda`). French title-casing is
reconstructed here; the accents cannot be. That makes the class mildly out-of-distribution and may
inflate the ABSOLUTE hallucination rate. It does not affect the comparison the board exists for —
every model sees the identical input, so relative rates and the T2 before/after are valid. Fix by
sourcing commune surfaces from a register that keeps them if the absolute number ever matters.

The negative class is the T1a lesson made structural. Every street harness in the arc filters to
rows carrying expect.street, so a street hallucinated on a locality-only row is invisible BY
CONSTRUCTION — and that is exactly where the span decode fails (12/54 shipped vs 19/54). A board
that cannot score the failure cannot grade the fix.

LABEL POLICY (fixed up front, per the review): the FULL street phrase is `street`, including the
designator, the particle, the apostrophe/elision, the hyphenated compound, and any date material.
`12 bis Rue X` -> house_number "12 bis", street "Rue X".

SPLIT: the chosen street_norm surfaces are emitted to ban-fragment-board.surfaces.txt. T2's training
shard MUST exclude them — source-disjoint by normalized street SURFACE, not by record row. A
row-disjoint split leaks the surface across the boundary and measures memorization of
`Rue de Rivoli` while claiming generalization to unseen streets.

Deterministic: fixed seed, sorted candidate pools. Re-running yields the identical board.

Run from repo root:  python3 scratchpad/build-ban-fragment-board.py
"""

import json
import random
import re
import sqlite3
import unicodedata

DB = "/mnt/playpen/mailwoman-data/ban/street-centroids-fr.db"
OUT = "mailwoman/eval-harness/fixtures/ban-fragments-fr.jsonl"
SURFACES = "mailwoman/eval-harness/fixtures/ban-fragments-fr.surfaces.txt"
PER_CLASS = 400
SEED = 727  # the issue number; any fixed value works, this one is a memo

# FR street designators. Kept to the unambiguous, high-frequency set — the board is measuring the
# model, not our ability to enumerate French.
DESIGNATORS = (
    "rue",
    "avenue",
    "boulevard",
    "place",
    "chemin",
    "impasse",
    "allee",
    "allée",
    "route",
    "quai",
    "cours",
    "square",
    "villa",
    "passage",
    "esplanade",
    "sentier",
)
PARTICLES = re.compile(r"\b(de la|de l'|du|des|de|d'|le|la|les)\b", re.I)
DATEISH = re.compile(r"\b(1[0-9]|20)\d{2}\b|\b\d{1,2}\s+(janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre)\b", re.I)


def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", strip_accents(s).lower()).strip()


def designator_of(raw: str):
    first = norm(raw).split(" ")[0] if raw else ""
    return first if first in {norm(d) for d in DESIGNATORS} else None


def name_part(raw: str) -> str:
    """The street minus its leading designator."""
    parts = raw.split(" ", 1)
    return parts[1] if len(parts) > 1 else ""


# French commune convention: capitalize each element, leave the joining particles lowercase.
# `saint-jean-de-luz` -> `Saint-Jean-de-Luz`, not `Saint-Jean-De-Luz`.
FR_LOWER = {"le", "la", "les", "de", "du", "des", "d", "l", "sur", "sous", "en", "aux", "au", "et", "lez", "les"}


def fr_title(s: str) -> str:
    def cap(tok: str, first: bool) -> str:
        return tok if (not first and tok in FR_LOWER) else (tok[:1].upper() + tok[1:])

    out = []
    for i, word in enumerate(s.split(" ")):
        bits = word.split("-")
        out.append("-".join(cap(b, i == 0 and j == 0) for j, b in enumerate(bits)))

    return " ".join(out)


def main() -> None:
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    rng = random.Random(SEED)

    print("loading localities…")
    localities = {
        norm(r[0]): r[0]
        for r in conn.execute("select distinct locality_base from street_centroid where locality_base != ''")
    }
    print(f"  {len(localities)} distinct communes")

    print("scanning streets (point_count >= 3, designator-led, clean surface)…")
    pools = {k: [] for k in ("bare-street", "street-particle", "date-name", "admin-street-homonym")}
    seen_surface = set()

    q = """
        select street_raw, postcode, locality_base, point_count
        from street_centroid
        where point_count >= 3 and street_raw not like '"%' and length(street_raw) between 6 and 48
        order by street_norm
    """
    for raw, postcode, locality, _pc in conn.execute(q):
        raw = raw.strip()
        if not raw or "  " in raw:
            continue
        # Deduplicate by SURFACE so no street can appear twice anywhere on the board — this is the
        # same key the T2 split must exclude on.
        key = norm(raw)
        if key in seen_surface:
            continue
        if designator_of(raw) is None:
            continue
        # A digit inside the street name muddies the house-number classes; keep those out except
        # where the digits ARE the name (the date class).
        has_date = bool(DATEISH.search(raw))
        if re.search(r"\d", raw) and not has_date:
            continue
        seen_surface.add(key)

        rec = {"raw": raw, "postcode": postcode, "locality": locality}
        nm = name_part(raw)
        if has_date:
            pools["date-name"].append(rec)
        elif norm(nm) in localities:
            pools["admin-street-homonym"].append(rec)
        elif PARTICLES.search(nm):
            pools["street-particle"].append(rec)
        else:
            pools["bare-street"].append(rec)

    for k, v in pools.items():
        print(f"  pool {k:22} {len(v):>7}")

    rows = []

    def take(pool_name, n):
        pool = pools[pool_name]
        return rng.sample(pool, min(n, len(pool)))

    # ---- positive classes -------------------------------------------------------------------
    for klass in ("bare-street", "street-particle", "date-name", "admin-street-homonym"):
        for rec in take(klass, PER_CLASS):
            rows.append(
                {
                    "klass": klass,
                    "input": rec["raw"],
                    "expect": {"street": [rec["raw"]]},
                    "surface": norm(rec["raw"]),
                    "source": "ban:fr",
                }
            )

    # street + house number, drawn from the bare/particle pools that are NOT already used
    used = {r["surface"] for r in rows}
    spare = [r for r in pools["bare-street"] + pools["street-particle"] if norm(r["raw"]) not in used]
    rng.shuffle(spare)

    for rec in spare[:PER_CLASS]:
        n = rng.choice([1, 2, 3, 5, 7, 8, 11, 12, 14, 15, 18, 21, 24, 27, 33, 42, 57, 68, 84, 102, 115, 140])
        rows.append(
            {
                "klass": "street-housenumber",
                "input": f"{n} {rec['raw']}",
                "expect": {"house_number": [str(n)], "street": [rec["raw"]]},
                "surface": norm(rec["raw"]),
                "source": "ban:fr",
            }
        )
    used |= {norm(r["raw"]) for r in spare[:PER_CLASS]}

    spare2 = [r for r in spare[PER_CLASS:] if norm(r["raw"]) not in used]

    for rec in spare2[:PER_CLASS]:
        n = rng.choice([1, 2, 3, 5, 7, 9, 11, 12, 14, 15, 18, 21, 24, 27, 33, 42])
        suffix = rng.choice(["bis", "ter", "B", "A"])
        hn = f"{n} {suffix}" if suffix in ("bis", "ter") else f"{n}{suffix}"
        rows.append(
            {
                "klass": "alnum-housenumber",
                "input": f"{hn} {rec['raw']}",
                "expect": {"house_number": [hn], "street": [rec["raw"]]},
                "surface": norm(rec["raw"]),
                "source": "ban:fr",
            }
        )

    # ---- the NEGATIVE class: bare localities, expect NO street --------------------------------
    # This is the row class the arc's street metric drops entirely, and where the span decode
    # actually fails. `expect.street` is deliberately absent; `expect_no_street` is the assertion.
    comm = sorted(localities.values())
    for locality in rng.sample(comm, min(PER_CLASS, len(comm))):
        pretty = fr_title(locality)
        rows.append(
            {
                "klass": "bare-locality",
                "input": pretty,
                "expect": {"locality": [pretty]},
                "expect_no_street": True,
                "surface": None,
                "source": "ban:fr",
            }
        )

    rows.sort(key=lambda r: (r["klass"], r["input"]))
    with open(OUT, "w", encoding="utf-8") as fh:
        for i, r in enumerate(rows):
            r["id"] = f"ban-fr-{i:05d}"
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    surfaces = sorted({r["surface"] for r in rows if r["surface"]})
    with open(SURFACES, "w", encoding="utf-8") as fh:
        fh.write(
            "# Normalized street surfaces reserved by the FR fragment board (T1c).\n"
            "# T2's BAN training shard MUST exclude every surface listed here — source-disjoint by\n"
            "# SURFACE, not by record row. A row-disjoint split leaks the surface across the boundary\n"
            "# and measures memorization instead of generalization to unseen streets.\n"
        )
        for s in surfaces:
            fh.write(s + "\n")

    from collections import Counter

    print(f"\nwrote {len(rows)} fixtures -> {OUT}")
    for k, v in sorted(Counter(r["klass"] for r in rows).items()):
        print(f"  {k:22} {v:>4}")
    print(f"reserved {len(surfaces)} street surfaces -> {SURFACES}")


if __name__ == "__main__":
    main()
