"""Real address parts, harvested from OpenAddresses CSVs and from an existing corpus's spans.

No collector here renders: each returns surfaces — street names, city names, (locality, region)
pairs — and `rows.py` turns them into labeled rows. Every collector seeds its own `random.Random`
from `SEED` plus a per-collector suffix, so one collector's sampling does not shift another's.
"""

from __future__ import annotations

import glob as globlib
import random
from collections.abc import Iterable, Iterator
from pathlib import Path

import pyarrow.parquet as pq
import spliterator

# locale dir -> (ISO country, BCP locale, trailing-number?)
OA_LOCALES: dict[str, tuple[str, str, bool]] = {
    "cz": ("CZ", "cs-CZ", True),
    "dk": ("DK", "da-DK", True),
    "es": ("ES", "es-ES", True),
    "hr": ("HR", "hr-HR", True),
    "nl": ("NL", "nl-NL", True),
    "no": ("NO", "nb-NO", True),
    "pl": ("PL", "pl-PL", True),
    "pt": ("PT", "pt-PT", True),
    "si": ("SI", "sl-SI", True),
    "sk": ("SK", "sk-SK", True),
    "au": ("AU", "en-AU", False),
    "nz": ("NZ", "en-NZ", False),
    "ch": ("CH", "de-CH", True),
}

#: The OpenAddresses files each locale reads, relative to `--oa-root`, in read order, each with the register row of
#: the body that publishes it. `corpus-source-inputs.json` lists every one of these rows under `fragment-assay`, and
#: each carries an elected decision permitting transform and train. A file whose publisher has no such row is left
#: out rather than read: Austria's BEV files, Finland's 2021 DVV extract and Sweden's municipal files, the Australian
#: state and council files, the New Zealand council files, and the two `countrywide-cityfilled.csv` files under `dk/`
#: and `fi/`, whose CITY column was filled from an unrecorded source. `ch/countrywide.csv` is the 2021 extract of the
#: BFS building and dwelling register (GWR), whose level A data the BFS states may be used without restriction.
#: Finland returns through Ryhti (`RYHTI_FILE`) rather than through an OpenAddresses file.
OA_FILES: dict[str, tuple[tuple[str, str], ...]] = {
    "au": (("au/countrywide.csv", "au-property-building-1"),),
    "ch": (("ch/countrywide.csv", "ch-property-building-2"),),
    "cz": (("cz/countrywide.csv", "cz-property-building-2"),),
    "dk": (("dk/countrywide.csv", "dk-property-building-1"),),
    "es": (("es/countrywide.csv", "es-property-building-1"),),
    "hr": (("hr/countrywide.csv", "hr-property-building-1"),),
    "nl": (("nl/countrywide.csv", "nl-property-building-2"),),
    "no": (("no/countrywide.csv", "no-property-building-1"),),
    "nz": (("nz/countrywide.csv", "nz-property-building-1"),),
    "pl": tuple(
        (f"pl/{voivodeship}.csv", "pl-property-building-1")
        for voivodeship in (
            "dolnoslaskie",
            "kujawsko-pomorskie",
            "lodzkie",
            "lubelskie",
            "lubuskie",
            "malopolskie",
            "mazowieckie",
            "opolskie",
            "podkarpackie",
            "podlaskie",
            "pomorskie",
            "slaskie",
            "swietokrzyskie",
            "warminsko-mazurskie",
            "wielkopolskie",
            "zachodniopomorskie",
        )
    ),
    "pt": (("pt/countrywide.csv", "pt-property-building-1"),),
    "si": (("si/countrywide.csv", "si-property-building-1"),),
    "sk": (("sk/countrywide.csv", "sk-property-building-1"),),
}

#: The corpus parts the global locality harvest reads, relative to `$MAILWOMAN_DATA_ROOT`. v0.5.0's first twelve train
#: parts hold only wof-admin rows (Who's On First, register row us-geodata-aggregate-2). Parts 0005 to 0009 hold the
#: US, FR, DE, GB, ES, NL and IT locality spans and part-0010 the CN, JP, KR and TW ones. A harvest over `part-000*`
#: reads parts 0000 to 0009 and reaches no CJK locality.
LOCALITY_PARQUET_GLOB = "corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-00*.parquet"

#: Ryhti's building address file, relative to `$MAILWOMAN_DATA_ROOT`, published by the Finnish Environment Institute
#: under CC BY 4.0 (register row fi-property-building-1).
RYHTI_FILE = "corpus/sources/ryhti/open_address.csv"
RYHTI_REGISTER_ROW = "fi-property-building-1"

PER_LOCALE_CAP = 4000
SEED = 42

#: Every row of this recipe output stores this wire identifier. Each `source_id` begins with it.
#:
#: `RECIPE_SOURCES` in `packages/corpus/lib/recipes/sources.ts` defines both spellings of this source.
#: It records `fragment-assay` as the current spelling. Python cannot import that table, so maintain
#: both values in sync. This constant matches the table's `current` field.
#: `WRITE_CURRENT_SOURCE_NAMES` in that file tells the TypeScript recipes which spelling to use.
#:
#: `v0.6.0-register-surface` and the `.pre-rename` copy of the staging directory store the retired spelling
#: `synth-fragment`, and the configs that target either corpus key on it. A run of this generator writes rows
#: for a corpus assembled after the rewrite, so it writes the current spelling.
#:
#: Composed into `source_id` rather than written twice, because `push` stamps the id from this and a rename
#: that changed one and not the other would make the id name a source absent from every row.
SOURCE = "fragment-assay"


#: One address record as the collectors read it: (street, number, city, postcode, unit), each stripped.
AddressRecord = tuple[str, str, str, str, str]

#: What a locale's collector returns: (street, number) pairs, cities, (city, postcode) pairs, (unit, number, street)
#: triples and (street, number, city) context triples, each sampled.
LocaleParts = tuple[
    list[tuple[str, str]],
    list[str],
    list[tuple[str, str]],
    list[tuple[str, str, str]],
    list[tuple[str, str, str]],
]


def _oa_records(csv_paths: list[Path]) -> Iterator[AddressRecord]:
    """Rows are read as arrays and the header matched case-insensitively, so a file's column order and spelling of
    `STREET`/`street` do not matter. Cells arrive trimmed, and invalid UTF-8 becomes U+FFFD."""
    for csv_path in csv_paths:
        rows = spliterator.read_csv(csv_path, header=False)
        header = next(rows, None)
        cols = {name.upper(): index for index, name in enumerate(header or [])}
        street_col = cols.get("STREET")

        if street_col is None:
            continue

        picked = (street_col, cols.get("NUMBER"), cols.get("CITY"), cols.get("POSTCODE"), cols.get("UNIT"))

        for row in rows:
            street, number, city, postcode, unit = (
                row[index] if index is not None and index < len(row) else "" for index in picked
            )
            yield street, number, city, postcode, unit


def _collect_parts(records: Iterable[AddressRecord], rng_key: str, cap: int) -> LocaleParts:
    """Accumulate distinct surfaces from `records` until `cap * 3` distinct streets are held, then sample each pool."""
    rng = random.Random(f"{SEED}:{rng_key}")
    pairs: dict[str, str] = {}
    cities: set[str] = set()
    city_postcodes: set[tuple[str, str]] = set()
    units: set[tuple[str, str, str]] = set()
    triples: set[tuple[str, str, str]] = set()

    for street, number, city, postcode, unit in records:
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

    sampled = rng.sample(sorted(pairs.items()), min(cap, len(pairs)))
    sampled_cities = rng.sample(sorted(cities), min(cap // 2, len(cities)))
    sampled_city_postcodes = rng.sample(sorted(city_postcodes), min(cap // 2, len(city_postcodes)))
    sampled_units = rng.sample(sorted(units), min(cap // 2, len(units)))
    sampled_triples = rng.sample(sorted(triples), min(cap // 2, len(triples)))

    return sampled, sampled_cities, sampled_city_postcodes, sampled_units, sampled_triples


def collect_oa_pairs(oa_root: Path, locale_dir: str, cap: int) -> LocaleParts:
    """Distinct (street, number) pairs and distinct CITY names from the OA CSVs `OA_FILES` lists for a locale.

    The city names feed bare-locality polarity rows, so a street-only fragment recipe does not teach
    "context-free name = street".

    :raises FileNotFoundError: when a listed file is absent, so a missing file cannot read as a locale with no rows.
    """
    csv_paths = [oa_root / relative for relative, _ in OA_FILES[locale_dir]]
    absent = [str(path) for path in csv_paths if not path.is_file()]

    if absent:
        raise FileNotFoundError(f"OpenAddresses files listed for {locale_dir} are absent: {', '.join(absent)}")

    return _collect_parts(_oa_records(csv_paths), locale_dir, cap)


def _ryhti_records(path: Path) -> Iterator[AddressRecord]:
    """Finnish-language records of Ryhti's `open_address.csv`.

    `address_fin` is the published rendering (`Vuorijärventie 216`), so the house number is the text after the street
    name rather than a value assembled from the number-part columns. A row without a Finnish street name is skipped.
    """
    for row in spliterator.read_csv(path):
        street = row.get("address_name_fin") or ""
        rendered = row.get("address_fin") or ""

        if not street:
            continue

        number = rendered[len(street) :].strip() if rendered.startswith(street + " ") else ""
        yield street, number, row.get("postal_office_fin") or "", row.get("postal_code") or "", ""


def collect_ryhti_pairs(path: Path, cap: int) -> LocaleParts:
    """The same pools `collect_oa_pairs` returns, read from Ryhti's building address file.

    :raises FileNotFoundError: when the file is absent, so a missing file cannot read as a locale with no rows.
    """
    if not path.is_file():
        raise FileNotFoundError(f"the Ryhti building address file is absent: {path}")

    return _collect_parts(_ryhti_records(path), "fi-ryhti", cap)


def span_rows_from_corpus(
    parquet_glob: str, countries: set[str] | None, cap: int, tag: str = "street", max_parts: int | None = None
) -> dict[str, list[str]]:
    """Bare surfaces of one span tag per country (``countries=None`` means all), lifted from an existing corpus.

    ``max_parts`` bounds the scan: without it a requested country that is sparse in the corpus never hits
    ``cap*2``, so the ``done`` break never fires and the loop walks every part — a measured 90-minute hang
    over ~700 parts (263M rows). The source-ordered corpus surfaces the common countries in the first parts.
    """
    rng = random.Random(f"{SEED}:corpus")
    out: dict[str, set[str]] = {c: set() for c in countries} if countries else {}

    done = False

    for path in sorted(globlib.glob(parquet_glob, recursive=True))[:max_parts]:
        if done:
            break

        # `iter_batches().to_pylist()` is row-aligned by construction. The code zips multiple ChunkedArrays
        # silently misaligns columns at chunk boundaries.
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
    """(locality, region) surface pairs from US corpus rows where both spans are present, teaching the
    locality/region boundary."""
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
