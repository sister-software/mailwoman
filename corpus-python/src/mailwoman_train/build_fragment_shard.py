"""Probe 1 (parity campaign): synthesize the fragment/autocomplete shard from REAL address parts.

Row types (the measured failure classes, night-1 postmortem):
  bare_street      "Vestre Haugen"        -> B-street [I-street ...]
  street_number    "Vestre Haugen 74"     -> street tokens + B-house_number   (EURO locales only —
                                             the trailing-number-tagged-postcode failure class;
                                             leading-number en-* forms are already base-dominant)

Sources: OpenAddresses extracts (STREET/NUMBER columns — real names, real number formats, per
locale), plus bare US/AU/NZ streets lifted from an existing corpus parquet's street spans (no local
OA `us` extract). Labels are by construction; spans are char offsets over the rendered text.

ASSAY TOOLING: if the assay confirms the data lever, the production shard graduates to the
`corpus/` TS generator convention (CONTRIBUTING_MODEL_WORK §Adding a shard). A 10% deterministic
holdout is written as JSONL (fragment-dev) for the read-out — NEVER into the trained shard.

Usage:
    python -m mailwoman_train.build_fragment_shard \
        --oa-root /mnt/playpen/mailwoman-data/openaddresses/extracted \
        --corpus-parquet-glob '/mnt/playpen/mailwoman-data/corpus/versioned/v0.5.0/**/train/part-000*.parquet' \
        --out-parquet out/part-fragment.parquet --out-dev out/fragment-dev.jsonl
"""

from __future__ import annotations

import argparse
import csv
import glob as globlib
import json
import random
from pathlib import Path

import pyarrow as pa
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


def collect_oa_pairs(oa_root: Path, locale_dir: str, cap: int) -> tuple[list[tuple[str, str]], list[str]]:
    """Distinct (street, number) pairs + distinct CITY names from a locale's OA CSVs.

    The city names feed bare-locality POLARITY rows: the #511 spread-scan measured shard street
    surfaces as ~46% street-family / ~54% admin in the base (European street names ARE place
    names), so a street-only fragment shard would teach "context-free name = street". The
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
    parquet_glob: str, countries: set[str] | None, cap: int, tag: str = "street"
) -> dict[str, list[str]]:
    """Bare surfaces of one span tag per country (countries=None -> ALL), lifted from an existing corpus."""
    rng = random.Random(f"{SEED}:corpus")
    out: dict[str, set[str]] = {c: set() for c in countries} if countries else {}

    done = False

    for path in sorted(globlib.glob(parquet_glob, recursive=True)):
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


def render(surface: str, number: str | None, tag: str = "street") -> dict:
    """Render a fragment row with by-construction BIO labels + char spans (tag: street|locality)."""
    surface_tokens = surface.split()
    tokens = list(surface_tokens)
    labels = [f"B-{tag}"] + [f"I-{tag}"] * (len(surface_tokens) - 1)
    text = surface

    if number:
        tokens.append(number)
        labels.append("B-house_number")
        text = f"{surface} {number}"

    # Char spans: the surface covers [0, len(surface)); the number starts after the joining space.
    span_starts, span_ends, span_tags = [0], [len(surface)], [tag]

    if number:
        span_starts.append(len(surface) + 1)
        span_ends.append(len(text))
        span_tags.append("house_number")

    return {
        "raw": text,
        "tokens": tokens,
        "labels": labels,
        "span_starts": span_starts,
        "span_ends": span_ends,
        "span_tags": span_tags,
    }


def render_locality_postcode(city: str, postcode: str) -> dict:
    """Shard-v2 (v251 read-out): the "Eight Mile Plains 4113" class — locality + trailing postcode."""
    tokens = city.split() + [postcode]
    labels = ["B-locality"] + ["I-locality"] * (len(city.split()) - 1) + ["B-postcode"]
    text = f"{city} {postcode}"

    return {
        "raw": text,
        "tokens": tokens,
        "labels": labels,
        "span_starts": [0, len(city) + 1],
        "span_ends": [len(city), len(text)],
        "span_tags": ["locality", "postcode"],
    }


COUNTRY_NAMES = {
    "AT": "Austria",
    "CH": "Switzerland",
    "CZ": "Czech Republic",
    "DK": "Denmark",
    "ES": "Spain",
    "FI": "Finland",
    "HR": "Croatia",
    "NL": "Netherlands",
    "NO": "Norway",
    "PL": "Poland",
    "PT": "Portugal",
    "SE": "Sweden",
    "SI": "Slovenia",
    "SK": "Slovakia",
    "AU": "Australia",
    "NZ": "New Zealand",
}


def render_context(street: str, number: str, city: str, country: str, trailing: bool, with_country: bool) -> dict:
    """Shard-v4: COMMA-FREE context rows — the failure-census headline class (71/143 street misses
    were unpunctuated street<->admin boundaries: "Rue Henri Barbusse Paris France"). Euro order
    STREET NUMBER CITY [COUNTRY]; en order NUMBER STREET CITY [COUNTRY]. No punctuation anywhere."""
    parts: list[tuple[str, str]] = []  # (tag, text)

    if trailing:
        parts = [("street", street), ("house_number", number), ("locality", city)]
    else:
        parts = [("house_number", number), ("street", street), ("locality", city)]

    if with_country:
        parts.append(("country", COUNTRY_NAMES[country]))

    tokens: list[str] = []
    labels: list[str] = []
    span_starts: list[int] = []
    span_ends: list[int] = []
    span_tags: list[str] = []
    cursor = 0
    pieces: list[str] = []

    for tag, text in parts:
        text_tokens = text.split()
        tokens.extend(text_tokens)
        labels.extend([f"B-{tag}"] + [f"I-{tag}"] * (len(text_tokens) - 1))
        span_starts.append(cursor)
        span_ends.append(cursor + len(text))
        span_tags.append(tag)
        pieces.append(text)
        cursor += len(text) + 1

    return {
        "raw": " ".join(pieces),
        "tokens": tokens,
        "labels": labels,
        "span_starts": span_starts,
        "span_ends": span_ends,
        "span_tags": span_tags,
    }


def render_unit(unit: str, number: str, street: str) -> dict:
    """Shard-v2: AU compact unit rows — "UNIT 711 139 BOUVERIE STREET" (unit, house_number, street)."""
    unit_tokens, street_tokens = unit.split(), street.split()
    tokens = unit_tokens + [number] + street_tokens
    labels = (
        ["B-unit"]
        + ["I-unit"] * (len(unit_tokens) - 1)
        + ["B-house_number"]
        + ["B-street"]
        + ["I-street"] * (len(street_tokens) - 1)
    )
    text = f"{unit} {number} {street}"
    number_start = len(unit) + 1
    street_start = number_start + len(number) + 1

    return {
        "raw": text,
        "tokens": tokens,
        "labels": labels,
        "span_starts": [0, number_start, street_start],
        "span_ends": [len(unit), number_start + len(number), len(text)],
        "span_tags": ["unit", "house_number", "street"],
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--oa-root", type=Path, required=True)
    ap.add_argument("--corpus-parquet-glob", required=True)
    ap.add_argument(
        "--famous-localities-file",
        default="",
        help="Shard-v4: newline list of top-population locality names (deterministic famous-city "
        "twins — closes the Dublin/Melbourne sampling-lottery class; build from the candidate "
        "gazetteer, population-ranked).",
    )
    ap.add_argument(
        "--locality-parquet-glob",
        default="",
        help="Separate glob for the GLOBAL locality-twin harvest (admin/ban blocks; the main glob "
        "typically points at the US-only tiger block). Defaults to the main glob.",
    )
    ap.add_argument("--out-parquet", type=Path, required=True)
    ap.add_argument("--out-dev", type=Path, required=True)
    ap.add_argument("--per-locale-cap", type=int, default=PER_LOCALE_CAP)
    args = ap.parse_args()

    rng = random.Random(SEED)
    rows: list[dict] = []

    def push(base: dict, country: str, locale: str, license_note: str) -> None:
        rows.append(
            {
                **base,
                "country": country,
                "locale": locale,
                "source": "synth-fragment",
                "source_id": f"synth-fragment-{country}-{len(rows)}",
                "corpus_version": "0.10.2",
                "license": license_note,
                "synth_method": "fragment-assay",
                "synth_base_id": None,
            }
        )

    for locale_dir, (country, locale, trailing) in sorted(OA_LOCALES.items()):
        pairs, cities, city_postcodes, units, triples = collect_oa_pairs(args.oa_root, locale_dir, args.per_locale_cap)
        license_note = f"Synthetic — fragment-assay; street/number/city from OpenAddresses {locale_dir}"

        for street, number in pairs:
            push(render(street, None), country, locale, license_note)

            if trailing and number and len(number) <= 8:
                push(render(street, number), country, locale, license_note)

        # Bare-locality polarity twins (see collect_oa_pairs docstring).
        for city in cities:
            push(render(city, None, tag="locality"), country, locale, license_note)

        for city, postcode in city_postcodes:
            push(render_locality_postcode(city, postcode), country, locale, license_note)

        for unit, number, street in units:
            push(render_unit(unit, number, street), country, locale, license_note)

        # Shard-v4: comma-free context rows (the census headline class — 71/143 street misses were
        # unpunctuated street<->admin boundaries). Alternate rows carry the English country name.
        for index, (street, number, city) in enumerate(triples):
            push(
                render_context(street, number, city, country, trailing, with_country=index % 2 == 0),
                country,
                locale,
                license_note,
            )

        print(
            f"{locale_dir}: {len(pairs)} pairs, {len(cities)} localities, {len(city_postcodes)} loc+pc, "
            f"{len(units)} units, {len(triples)} context"
        )

    corpus_streets = span_rows_from_corpus(args.corpus_parquet_glob, {"US"}, args.per_locale_cap)
    # Shard-v3: GLOBAL bare-locality twins (all countries; cap/4 each) — the gauntlet
    # global-dublin-bare regression showed famous cities outside the OA shard locales lose their
    # locality reading once fragment street-mass grows. Harvested from real corpus locality spans.
    if args.famous_localities_file:
        famous = [line.strip() for line in open(args.famous_localities_file, encoding="utf-8") if line.strip()]

        for name in famous:
            push(
                render(name, None, tag="locality"),
                "ZZ",
                "und",
                "Synthetic — fragment-assay; top-population locality names from the candidate gazetteer (WOF-derived)",
            )

        print(f"famous-locality twins: {len(famous)}")

    corpus_localities = span_rows_from_corpus(
        args.locality_parquet_glob or args.corpus_parquet_glob, None, args.per_locale_cap // 4, tag="locality"
    )

    for country, localities in sorted(corpus_localities.items()):
        for name in localities:
            push(
                render(name, None, tag="locality"),
                country,
                "und",
                "Synthetic — fragment-assay; locality surfaces from corpus v0.5.0 spans",
            )

    print(
        f"corpus locality twins: {sum(len(v) for v in corpus_localities.values())} across {len(corpus_localities)} countries"
    )

    for country, streets in sorted(corpus_streets.items()):
        for street in streets:
            push(
                render(street, None),
                country,
                "en-US",
                "Synthetic — fragment-assay; street surfaces from corpus v0.5.0 spans",
            )

        print(f"corpus:{country}: {len(streets)} bare streets")

    rng.shuffle(rows)
    dev_count = len(rows) // 10
    dev, train = rows[:dev_count], rows[dev_count:]

    args.out_parquet.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(train), args.out_parquet)
    args.out_dev.parent.mkdir(parents=True, exist_ok=True)

    with open(args.out_dev, "w", encoding="utf-8") as fh:
        for row in dev:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(f"shard: {len(train)} rows -> {args.out_parquet}")
    print(f"dev:   {len(dev)} rows -> {args.out_dev}")


if __name__ == "__main__":
    main()
