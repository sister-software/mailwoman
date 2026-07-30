"""Build the DE fragment board (G8's instrument — the v7 DE-fold value gate, v8.3.0 ladder).

Mirrors the FR board's taxonomy (`ban-fragments-fr.jsonl`, 7 classes × 400 with Wilson-interval
support) from Overture-DE (2026-06-17.0, 800k rows, `address_levels = [state code, municipality]`),
with the class rules translated to German surface reality:

- `street-particle` — the preposition-led class (Am/An der/Zur/Im/Unter den …), the DE analog of
  the FR particle class.
- `date-name` — German date-streets (Straße des 17. Juni; digit + month names).
- `admin-street-homonym` — data-driven per the operative definition: a street whose painter-folded
  word n-grams hit a locality-surface-lexicon-v7 entry WOULD get locality evidence painted; that
  is the class the DE fold can help or hurt. (German inflection — "Berliner Straße" ≠ "berlin" —
  keeps this class smaller than FR's; the exact-match residue is the honest population.)
- `street-housenumber` / `alnum-housenumber` — German order, number AFTER street ("Hauptstraße
  12" / "12a").
- `bare-street`, `bare-locality` (expect_no_street — the negative class is the point).

SPLIT DISCIPLINE (recorded, weaker than FR's): the training feed's only DE street data is the
synth-german shard (OA Berlin + Sachsen), so the board excludes state codes BE and SN entirely —
GEOGRAPHIC disjointness. Ubiquitous street vocabulary (Hauptstraße) still repeats across Länder;
the board therefore measures class behavior over shared vocabulary with held-out compositions,
not FR-grade surface disjointness. The reserved-surface list is still emitted for future shard
builders.

Usage:
  uv run python scripts/build_de_fragment_board.py [--per-class 400] [--seed 42] \
      [--out mailwoman/eval-harness/fixtures/overture-fragments-de.jsonl]
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import unicodedata
from pathlib import Path

import pyarrow.parquet as pq

DATA_ROOT = os.environ.get("MAILWOMAN_DATA_ROOT", "/mnt/playpen/mailwoman-data")
PARQUET = Path(DATA_ROOT) / "overture" / "2026-06-17.0" / "addresses-de.parquet"
LEXICON = Path(DATA_ROOT) / "gazetteer" / "locality-surface-lexicon-v7.json"

TRAINING_STATES = {"BE", "SN"}  # synth-german's OA parts — geographically excluded.

PARTICLE = re.compile(
    r"^(am|an der|an den|zur|zum|auf der|auf dem|im|in der|in den|unter den|unter der|hinter der|hinter dem|vor der|vor dem|bei der|beim|an|zu)\s",
    re.IGNORECASE,
)
DATEISH = re.compile(
    r"\b\d{1,2}\.?\s*(januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember)\b|\bstra(ß|ss)e des \d",
    re.IGNORECASE,
)
ALNUM_NUMBER = re.compile(r"\d[a-zA-Z]|[a-zA-Z]\d|\d[-/]\d")

KLASSES = (
    "admin-street-homonym",
    "alnum-housenumber",
    "bare-locality",
    "bare-street",
    "date-name",
    "street-housenumber",
    "street-particle",
)


def painter_fold(surface: str) -> list[str]:
    """The painter's word fold (mirrors evidence-lexicons.ts painterFold)."""
    out = []
    for w in surface.split():
        w = re.sub(r"^[^\w]+|[^\w]+$", "", w, flags=re.UNICODE)
        if w:
            out.append(w.lower())
    return out


def norm_surface(s: str) -> str:
    return " ".join(painter_fold(unicodedata.normalize("NFC", s)))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-class", type=int, default=400)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default="mailwoman/eval-harness/fixtures/overture-fragments-de.jsonl")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    lexicon_entries = set(json.loads(LEXICON.read_text())["entries"].keys())

    def hits_lexicon(street: str) -> bool:
        toks = painter_fold(street)
        for n in range(1, min(len(toks), 4) + 1):
            for i in range(len(toks) - n + 1):
                if " ".join(toks[i : i + n]) in lexicon_entries:
                    return True
        return False

    # Seeded per-class reservoirs; one street surface appears at most once per class.
    res: dict[str, list[dict]] = {k: [] for k in KLASSES}
    seen_counts: dict[str, int] = {k: 0 for k in KLASSES}
    seen_surfaces: dict[str, set[str]] = {k: set() for k in KLASSES}

    def offer(klass: str, row: dict, dedupe_key: str) -> None:
        if dedupe_key in seen_surfaces[klass]:
            return
        seen_surfaces[klass].add(dedupe_key)
        seen_counts[klass] += 1
        if len(res[klass]) < args.per_class:
            res[klass].append(row)
        else:
            j = rng.randrange(seen_counts[klass])
            if j < args.per_class:
                res[klass][j] = row

    pf = pq.ParquetFile(PARQUET)
    for batch in pf.iter_batches(batch_size=65536, columns=["street", "number", "address_levels"]):
        streets = batch["street"].to_pylist()
        numbers = batch["number"].to_pylist()
        levels = batch["address_levels"].to_pylist()
        for street, number, lv in zip(streets, numbers, levels, strict=True):
            if not lv or len(lv) < 2 or not lv[0]["value"] or lv[0]["value"] in TRAINING_STATES:
                continue
            muni = lv[1]["value"]
            if muni:
                offer(
                    "bare-locality",
                    {"input": muni, "expect_no_street": True, "surface": norm_surface(muni)},
                    norm_surface(muni),
                )
            if not street or len(street) < 3:
                continue
            surface = norm_surface(street)
            if not surface:
                continue
            if DATEISH.search(street):
                offer("date-name", {"input": street, "expect": {"street": [street]}, "surface": surface}, surface)
            elif PARTICLE.match(street):
                offer("street-particle", {"input": street, "expect": {"street": [street]}, "surface": surface}, surface)
            elif hits_lexicon(street):
                offer(
                    "admin-street-homonym",
                    {"input": street, "expect": {"street": [street]}, "surface": surface},
                    surface,
                )
            else:
                offer("bare-street", {"input": street, "expect": {"street": [street]}, "surface": surface}, surface)
            if number:
                hn_input = f"{street} {number}"  # German order: number after street.
                hn_klass = "alnum-housenumber" if ALNUM_NUMBER.search(number) else "street-housenumber"
                offer(
                    hn_klass,
                    {"input": hn_input, "expect": {"street": [street]}, "surface": surface},
                    f"{surface}|{number}",
                )

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    surfaces: set[str] = set()
    n_rows = 0
    with out_path.open("w", encoding="utf-8") as fh:
        for klass in KLASSES:
            rows = res[klass]
            if len(rows) < args.per_class:
                print(f"WARN {klass}: only {len(rows)} rows (wanted {args.per_class})")
            for i, r in enumerate(rows):
                rec = {"klass": klass, **r, "source": "overture:de", "id": f"ovt-de-{klass}-{i:05d}"}
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                surfaces.add(r["surface"])
                n_rows += 1

    surfaces_path = out_path.with_suffix("").with_suffix("")  # strip .jsonl
    surfaces_path = out_path.parent / (out_path.stem + ".surfaces.txt")
    surfaces_path.write_text("\n".join(sorted(surfaces)) + "\n", encoding="utf-8")
    print(f"{out_path}: {n_rows} rows across {len(KLASSES)} classes; {len(surfaces)} reserved surfaces")
    for klass in KLASSES:
        print(f"  {klass:<22} {len(res[klass])}")


if __name__ == "__main__":
    main()
