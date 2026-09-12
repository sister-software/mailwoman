"""Real address parts, harvested from OpenAddresses CSVs and from an existing corpus's spans.

Nothing here renders. Each collector returns surfaces — street names, city names, (locality,
region) pairs — and `rows.py` turns them into labeled rows. Every collector seeds its own
`random.Random` from `SEED` plus a per-collector suffix, so one collector's sampling does not
shift another's.
"""

from __future__ import annotations

import csv
import glob as globlib
import random
from pathlib import Path

import pyarrow.parquet as pq

# locale dir -> (ISO country, BCP locale, trailing-number?)
OA_LOCALES: dict[str, tuple[str, str, bool]] = {
    "at": ("AT", "de-AT", True),
    "ch": ("CH", "de-CH", True),
    "cz": ("CZ", "cs-CZ", True),
    "dk": ("DK", "da-DK", True),
    "es": ("ES", "es-ES", True),
    "fi": ("FI", "fi-FI", True),
    "hr": ("HR", "hr-HR", True),
    "nl": ("NL", "nl-NL", True),
    "no": ("NO", "nb-NO", True),
    "pl": ("PL", "pl-PL", True),
    "pt": ("PT", "pt-PT", True),
    "se": ("SE", "sv-SE", True),
    "si": ("SI", "sl-SI", True),
    "sk": ("SK", "sk-SK", True),
    "au": ("AU", "en-AU", False),
    "nz": ("NZ", "en-NZ", False),
}

PER_LOCALE_CAP = 4000
SEED = 42


def collect_oa_pairs(
    oa_root: Path,
    locale_dir: str,
    cap: int,
) -> tuple[
    list[tuple[str, str]],
    list[str],
    list[tuple[str, str]],
    list[tuple[str, str, str]],
    list[tuple[str, str, str]],
]:
    """Distinct (street, number) pairs + distinct CITY names from a locale's OA CSVs.

    The city names feed bare-locality POLARITY rows: the #511 spread-scan measured slice street
    surfaces as ~46% street-family / ~54% admin in the base (European street names ARE place
    names), so a street-only fragment slice would teach "context-free name = street". The
    established family (si-bare-village / fr-bare-street) balances polarity; fragments balance
    with bare-locality twins so the discriminant the model can learn is morphology/lexical
    identity, not fragment-ness.
    """
    rng = random.Random(f"{SEED}:{locale_dir}")
    pairs: dict[str, str] = {}
    cities: set[str] = set()
    city_postcodes: set[tuple[str, str]] = set()
    units: set[tuple[str, str, str]] = set()
    triples: set[tuple[str, str, str]] = set()

    for csv_path in sorted(globlib.glob(str(oa_root / locale_dir / "**" / "*.csv"), recursive=True)):
        with open(csv_path, newline="", encoding="utf-8", errors="replace") as fh:
            reader = csv.DictReader(fh)
            cols = {c.upper(): c for c in reader.fieldnames or []}
            street_col, number_col = cols.get("STREET"), cols.get("NUMBER")
            city_col = cols.get("CITY")
            unit_col, postcode_col = cols.get("UNIT"), cols.get("POSTCODE")

            if not street_col:
                continue

            for row in reader:
                street = (row.get(street_col) or "").strip()
                number = (row.get(number_col) or "").strip() if number_col else ""
                city = (row.get(city_col) or "").strip() if city_col else ""

                postcode = (row.get(postcode_col) or "").strip() if postcode_col else ""
                unit = (row.get(unit_col) or "").strip() if unit_col else ""

                if city and 3 <= len(city) <= 48 and not city.isdigit() and len(cities) < cap * 3:
                    cities.add(city)

                if city and postcode and 3 <= len(postcode) <= 10 and len(city_postcodes) < cap * 2:
                    city_postcodes.add((city, postcode))

                if not street or len(street) < 3 or len(street) > 48 or street.isdigit():
                    continue

                if unit and number and len(unit) <= 12 and len(number) <= 8 and len(units) < cap:
                    units.add((unit, number, street))

                if city and number and len(number) <= 8 and 3 <= len(city) <= 40 and len(triples) < cap:
                    triples.add((street, number, city))

                if street not in pairs:
                    pairs[street] = number

                if len(pairs) >= cap * 3:
                    break

        if len(pairs) >= cap * 3:
            break

    sampled = rng.sample(sorted(pairs.items()), min(cap, len(pairs)))
    sampled_cities = rng.sample(sorted(cities), min(cap // 2, len(cities)))
    sampled_city_postcodes = rng.sample(sorted(city_postcodes), min(cap // 2, len(city_postcodes)))
    sampled_units = rng.sample(sorted(units), min(cap // 2, len(units)))
    sampled_triples = rng.sample(sorted(triples), min(cap // 2, len(triples)))

    return sampled, sampled_cities, sampled_city_postcodes, sampled_units, sampled_triples


def span_rows_from_corpus(
    parquet_glob: str, countries: set[str] | None, cap: int, tag: str = "street", max_parts: int | None = None
) -> dict[str, list[str]]:
    """Bare surfaces of one span tag per country (countries=None -> ALL), lifted from an existing corpus.

    ``max_parts`` bounds the scan: without it, a REQUESTED country that is SPARSE in the corpus (e.g. DE
    streets) never hits ``cap*2``, so the ``done`` break never fires and the loop walks all ~700 parts
    (263M rows) — a 90+ min hang measured 2026-07-14. Bound the scan for such calls; the source-ordered
    corpus surfaces enough of the common countries in the first N parts.
    """
    rng = random.Random(f"{SEED}:corpus")
    out: dict[str, set[str]] = {c: set() for c in countries} if countries else {}

    done = False

    for path in sorted(globlib.glob(parquet_glob, recursive=True))[:max_parts]:
        if done:
            break

        # iter_batches().to_pylist() is row-aligned by construction; zipping multiple ChunkedArrays
        # is NOT (chunk-boundary iteration artifacts silently misalign columns — measured).
        for batch in pq.ParquetFile(path).iter_batches(
            columns=["raw", "span_starts", "span_ends", "span_tags", "country"], batch_size=8192
        ):
            for row in batch.to_pylist():
                c = row["country"]

                if countries is None and c not in out:
                    out[c] = set()

                if c not in out or len(out[c]) >= cap * 2:
                    continue

                text = row["raw"]

                for s, e, t in zip(row["span_starts"], row["span_ends"], row["span_tags"], strict=True):
                    if t == tag:
                        surface = text[s:e].strip()

                        if 3 <= len(surface) <= 48 and not surface.isdigit():
                            out[c].add(surface)

            if out and all(len(v) >= cap * 2 for v in out.values()):
                done = True
                break

    return {c: rng.sample(sorted(v), min(cap, len(v))) for c, v in out.items() if v}


def admin_pairs_from_corpus(parquet_glob: str, cap: int) -> list[tuple[str, str]]:
    """(locality, region) surface pairs from US corpus rows (both spans present) — the #1102
    counterweight: teaches the locality<->region boundary the twin mass eroded."""
    rng = random.Random(f"{SEED}:adminpairs")
    pairs: set[tuple[str, str]] = set()

    for path in sorted(globlib.glob(parquet_glob, recursive=True)):
        for batch in pq.ParquetFile(path).iter_batches(
            columns=["raw", "span_starts", "span_ends", "span_tags", "country"], batch_size=8192
        ):
            for row in batch.to_pylist():
                if row["country"] != "US" or len(pairs) >= cap * 3:
                    continue

                text = row["raw"]
                locality = region = None

                for s_, e_, t_ in zip(row["span_starts"], row["span_ends"], row["span_tags"], strict=True):
                    if t_ == "locality":
                        locality = text[s_:e_].strip()
                    elif t_ == "region":
                        region = text[s_:e_].strip()

                if locality and region and 3 <= len(locality) <= 40 and 2 <= len(region) <= 20:
                    pairs.add((locality, region))

            if len(pairs) >= cap * 3:
                break

        if len(pairs) >= cap * 3:
            break

    return rng.sample(sorted(pairs), min(cap, len(pairs)))
