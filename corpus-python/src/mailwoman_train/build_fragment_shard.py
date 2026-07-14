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


def render_admin_pair(locality: str, region: str) -> dict:
    """US "LOCALITY REGION" comma-free pair — the locality<->region boundary row."""
    locality_tokens, region_tokens = locality.split(), region.split()
    tokens = locality_tokens + region_tokens
    labels = (
        ["B-locality"]
        + ["I-locality"] * (len(locality_tokens) - 1)
        + ["B-region"]
        + ["I-region"] * (len(region_tokens) - 1)
    )
    text = f"{locality} {region}"

    return {
        "raw": text,
        "tokens": tokens,
        "labels": labels,
        "span_starts": [0, len(locality) + 1],
        "span_ends": [len(locality), len(text)],
        "span_tags": ["locality", "region"],
    }


# Country surfaces come from @mailwoman/codex (COUNTRY_SURFACE_FORMS + ISO2_TO_NAME), NOT re-derived
# here — the codex is the single source of truth. `codex/tools/export-country-surfaces.ts` snapshots it
# across the TS→Python boundary into the data file below (regenerate it when the codex changes). Filter
# to word-forms (len ≥ 3) so an address TAIL is "USA" / "United States", never the bare "US" alpha-2
# code (ambiguous with a US state code at the tail). Golden gold IS the surface, e.g.
# "6220 SE Salmon St, Portland, OR 97215, USA" → country="USA".
_COUNTRY_SURFACES_RAW = json.loads(
    (Path(__file__).parent / "data" / "country-surfaces.json").read_text(encoding="utf-8")
)["surfaces"]
COUNTRY_SURFACES: dict[str, list[str]] = {
    iso2: [f for f in forms if len(f) >= 3] for iso2, forms in _COUNTRY_SURFACES_RAW.items()
}
COUNTRY_SURFACES = {iso2: forms for iso2, forms in COUNTRY_SURFACES.items() if forms}


def render_country_context(street: str, number: str, city: str, country_name: str, trailing: bool, comma: bool) -> dict:
    """#1104 country counterweight: a full address ENDING in a country token, comma'd OR comma-free, so the
    fine-tune keeps the country class alive — the shard-v5 mass (bare streets/localities/admin pairs) is
    country-SPARSE and eroded country recall 88.6%→82.0%. Fields are groups (number+street space-joined as
    one unit); groups are joined by ", " (comma'd) or " " (comma-free). Cursor-tracks char-offset spans."""
    groups: list[list[tuple[str, str]]] = (
        [[("street", street), ("house_number", number)]]
        if trailing
        else [[("house_number", number), ("street", street)]]
    )
    groups += [[("locality", city)], [("country", country_name)]]
    sep = ", " if comma else " "

    tokens: list[str] = []
    labels: list[str] = []
    span_starts: list[int] = []
    span_ends: list[int] = []
    span_tags: list[str] = []
    surfaces: list[str] = []
    cursor = 0

    for gi, group in enumerate(groups):
        if gi > 0:
            cursor += len(sep)
        parts: list[str] = []

        for pi, (tag, text) in enumerate(group):
            if pi > 0:
                cursor += 1  # intra-group space
            text_tokens = text.split()
            tokens.extend(text_tokens)
            labels.extend([f"B-{tag}"] + [f"I-{tag}"] * (len(text_tokens) - 1))
            span_starts.append(cursor)
            span_ends.append(cursor + len(text))
            span_tags.append(tag)
            parts.append(text)
            cursor += len(text)
        surfaces.append(" ".join(parts))

    return {
        "raw": sep.join(surfaces),
        "tokens": tokens,
        "labels": labels,
        "span_starts": span_starts,
        "span_ends": span_ends,
        "span_tags": span_tags,
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

        # Shard-v6 (#1104): COUNTRY counterweight — the shard-v5 mass is country-sparse, which eroded
        # country recall 88.6%→82.0% on the fragment lineage. Emit a full address ENDING in the country
        # token per triple, BOTH comma'd and comma-free (golden has both), rotating the codex surface
        # forms, so the fine-tune keeps the country class alive without touching the fragment gains.
        surfaces = COUNTRY_SURFACES.get(country, [])

        if surfaces:
            for si, (street, number, city) in enumerate(triples):
                if not number or len(number) > 8:
                    continue
                surface = surfaces[si % len(surfaces)]
                push(
                    render_country_context(street, number, city, surface, trailing, comma=True),
                    country,
                    locale,
                    license_note,
                )
                push(
                    render_country_context(street, number, city, surface, trailing, comma=False),
                    country,
                    locale,
                    license_note,
                )

        print(
            f"{locale_dir}: {len(pairs)} pairs, {len(cities)} localities, {len(city_postcodes)} loc+pc, "
            f"{len(units)} units, {len(triples)} context"
        )

    corpus_streets = span_rows_from_corpus(args.corpus_parquet_glob, {"US"}, args.per_locale_cap, max_parts=150)
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

    # Shard-v5 (#1102): US admin-context pairs + directional-prefixed locality twin boost.
    admin_pairs = admin_pairs_from_corpus(args.corpus_parquet_glob, args.per_locale_cap)

    for locality, region in admin_pairs:
        push(
            render_admin_pair(locality, region),
            "US",
            "en-US",
            "Synthetic — fragment-assay; (locality, region) pairs from corpus US spans",
        )

    directional_localities = [
        (loc, reg)
        for loc, reg in admin_pairs
        if loc.split()[0].rstrip(".").upper()
        in {"N", "S", "E", "W", "NORTH", "SOUTH", "EAST", "WEST", "NE", "NW", "SE", "SW"}
    ]

    for loc, _ in directional_localities:
        push(
            render(loc, None, tag="locality"),
            "US",
            "en-US",
            "Synthetic — fragment-assay; directional-prefixed US localities (the N-Hartland flip class)",
        )

    print(f"US admin pairs: {len(admin_pairs)} (directional-locality twins: {len(directional_localities)})")

    corpus_localities = span_rows_from_corpus(
        args.locality_parquet_glob or args.corpus_parquet_glob,
        None,
        args.per_locale_cap // 4,
        tag="locality",
        max_parts=150,
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

    # Shard-v6 (#1104): country counterweight. The golden country classes are US + FR heavy, and NEITHER
    # is an OA_LOCALES locale, so those tails had ZERO signal — the country-sparse fine-tune eroded
    # recall 88.6%→82.0%. The corpus rarely co-locates street+locality in one row (WOF-admin-heavy), so
    # synthesize by ZIPPING separate street + locality pools (both DO exist in the corpus) with a codex
    # country surface tail (COUNTRY_SURFACES, sourced from @mailwoman/codex), comma'd AND comma-free.
    _country_note = (
        "Synthetic — fragment-assay; #1104 country counterweight (corpus street × locality + codex surface tail)"
    )
    # The golden country classes are US + FR heavy (us.jsonl / fr.jsonl); DE rounds out the common tails.
    # A modest cap (not the full 4000) bounds the extra scan — a few thousand country rows × the fragment
    # weight is ample counterweight without letting country dominate the shard.
    country_seed_countries = {"US", "FR", "DE"}
    number_first = {"US", "GB", "CA", "FR"}  # NUMBER STREET; the rest (DE/IT/ES/AT/…) are STREET NUMBER
    country_cap = min(args.per_locale_cap, 1500)
    # Bound the scan (max_parts) — DE streets are sparse in the corpus, so an unbounded scan walks all
    # 700 parts hunting a cap it never reaches (the 2026-07-14 90-min hang). 120 parts surfaces plenty
    # of US/FR and whatever DE the head carries.
    country_seed_streets = span_rows_from_corpus(
        args.corpus_parquet_glob, country_seed_countries, country_cap, tag="street", max_parts=120
    )
    country_rng = random.Random(f"{SEED}:countryrows")
    country_rows = 0

    for c in sorted(country_seed_countries):
        surfaces = COUNTRY_SURFACES.get(c, [])
        streets = country_seed_streets.get(c, [])
        localities = corpus_localities.get(c, [])

        if not (surfaces and streets and localities):
            continue

        trailing_c = c not in number_first

        for si, street in enumerate(streets):
            locality = localities[si % len(localities)]
            number = str(country_rng.randint(1, 3999))
            surface = surfaces[si % len(surfaces)]
            push(
                render_country_context(street, number, locality, surface, trailing_c, comma=True),
                c,
                "und",
                _country_note,
            )
            push(
                render_country_context(street, number, locality, surface, trailing_c, comma=False),
                c,
                "und",
                _country_note,
            )
            country_rows += 2

    print(f"#1104 country counterweight: {country_rows} rows across the seed countries")

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
