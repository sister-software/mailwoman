"""Probe 1 (parity campaign): synthesize the fragment/autocomplete slice from REAL address parts.

Row types (the measured failure classes, night-1 postmortem):
  bare_street      "Vestre Haugen"        -> B-street [I-street ...]
  street_number    "Vestre Haugen 74"     -> street tokens + B-house_number   (EURO locales only —
                                             the trailing-number-tagged-postcode failure class;
                                             leading-number en-* forms are already base-dominant)

Sources: OpenAddresses extracts (STREET/NUMBER columns — real names, real number formats, per
locale), plus bare US/AU/NZ streets lifted from an existing corpus parquet's street spans (no local
OA `us` extract). Labels are by construction; spans are char offsets over the rendered text.

ASSAY TOOLING: if the assay confirms the data change, the production slice graduates to the
`corpus/` TS generator convention (CONTRIBUTING_MODEL_WORK §Adding a slice). A 10% deterministic
holdout is written as JSONL (fragment-dev) for the read-out — NEVER into the trained slice.

`push` stamps every row with the same provenance block and a running `source_id`, so the ORDER
these blocks run in is baked into the ids and into the 10% holdout the final shuffle cuts. Adding
a block in the middle renumbers everything after it.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from .rows import (
    COUNTRY_SURFACES,
    render,
    render_admin_pair,
    render_context,
    render_country_context,
    render_country_leading,
    render_locality_postcode,
    render_unit,
)
from .sources import (
    OA_LOCALES,
    PER_LOCALE_CAP,
    SEED,
    admin_pairs_from_corpus,
    collect_oa_pairs,
    span_rows_from_corpus,
)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--oa-root", type=Path, required=True)
    ap.add_argument("--corpus-parquet-glob", required=True)
    ap.add_argument(
        "--famous-localities-file",
        default="",
        help="Slice-v4: newline list of top-population locality names (deterministic famous-city "
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
    rows: list[dict[str, Any]] = []

    def push(base: dict[str, Any], country: str, locale: str, license_note: str) -> None:
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

        # Slice-v4: comma-free context rows (the census headline class — 71/143 street misses were
        # unpunctuated street<->admin boundaries). Alternate rows carry the English country name.
        for index, (street, number, city) in enumerate(triples):
            push(
                render_context(street, number, city, country, trailing, with_country=index % 2 == 0),
                country,
                locale,
                license_note,
            )

        # Slice-v6 (#1104): COUNTRY counterweight — the slice-v5 mass is country-sparse, which eroded
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

    corpus_streets = span_rows_from_corpus(args.corpus_parquet_glob, {"US"}, args.per_locale_cap, max_parts=30)
    # Slice-v3: GLOBAL bare-locality twins (all countries; cap/4 each) — the gauntlet
    # global-dublin-bare regression showed famous cities outside the OA slice locales lose their
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

    # Slice-v5 (#1102): US admin-context pairs + directional-prefixed locality twin boost.
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
        max_parts=12,
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

    # Slice-v6 (#1104): country counterweight. The golden country classes are US + FR heavy, and NEITHER
    # is an OA_LOCALES locale, so those tails had ZERO signal — the country-sparse fine-tune eroded
    # recall 88.6%→82.0%. The corpus rarely co-locates street+locality in one row (WOF-admin-heavy), so
    # synthesize by ZIPPING separate street + locality pools (both DO exist in the corpus) with a codex
    # country surface tail (COUNTRY_SURFACES, sourced from @mailwoman/codex), comma'd AND comma-free.
    _country_note = (
        "Synthetic — fragment-assay; #1104 country counterweight (corpus street × locality + codex surface tail)"
    )
    # US is the biggest golden country class (us.jsonl) and the corpus's US streets (tiger/nad) are what
    # --corpus-parquet-glob points at. FR streets live in a DIFFERENT source block (BAN) that this glob
    # doesn't cover, so seed US only here; FR/DE ride the 16 OA-locale country rows + a later BAN pass if
    # still short. A modest cap keeps country from dominating the slice.
    country_seed_countries = {"US"}
    number_first = {"US", "GB", "CA", "FR"}  # NUMBER STREET; the rest (DE/IT/ES/AT/…) are STREET NUMBER
    country_cap = min(args.per_locale_cap, 1500)
    country_seed_streets = span_rows_from_corpus(
        args.corpus_parquet_glob, country_seed_countries, country_cap, tag="street", max_parts=40
    )
    country_rng = random.Random(f"{SEED}:countryrows")
    country_rows = 0

    # US localities: the NAD admin pairs (English city names), NOT corpus_localities — the wof-admin
    # locality harvest carries alternate-language surfaces ("Сельма"/"п'єдмонт"), which would teach a
    # nonsense "English-street cyrillic-city USA" tail. ASCII-filter as a safety net for any locale.
    country_localities: dict[str, list[str]] = {"US": [loc for loc, _ in admin_pairs]}

    for c in sorted(country_seed_countries):
        surfaces = COUNTRY_SURFACES.get(c, [])
        streets = [s for s in country_seed_streets.get(c, []) if s.isascii()]
        localities = [
            locality for locality in country_localities.get(c, corpus_localities.get(c, [])) if locality.isascii()
        ]

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

    # v2.9.1 (#1104): LEADING-position country rows — "United States of America, Wyoming, Лорейн"
    # (country FIRST). The v290 tail-only counterweight recovered tail cases but MISSED this WOF-admin
    # distribution (12/60 golden misses, all leading-position + non-Latin locality). Regions from NAD
    # admin_pairs; localities from corpus_localities["US"] INCLUDING non-Latin (the point — teach country
    # when the locality context is non-Latin). Rotate the codex surfaces (the golden favors the long
    # "United States of America" form here).
    us_regions = [reg for _, reg in admin_pairs]
    us_localities_all = corpus_localities.get("US", [])
    us_surfaces = COUNTRY_SURFACES.get("US", [])
    # v2.9.2 (#1104): weight the LEADING surfaces to the MULTI-WORD forms ("United States of America",
    # "United States"). The v291 probe pinned the residual EXACTLY there: short leading forms ("USA, AZ,
    # …" → country=USA) already parse; only the long form fails ("United States of America, …" → the
    # 4-token phrase reads as a STREET). Rotating all 6 surfaces gave the long form only ~1/6 of leading
    # rows. Bias to the multi-word forms so the model gets enough signal to stop reading them as street.
    leading_surfaces = [s for s in us_surfaces if len(s.split()) >= 2] or us_surfaces
    leading_rows = 0

    if us_regions and us_localities_all and leading_surfaces:
        n = min(len(us_regions), country_cap)
        for i in range(n):
            surface = leading_surfaces[i % len(leading_surfaces)]
            region = us_regions[i]
            locality = us_localities_all[i % len(us_localities_all)]
            push(render_country_leading(surface, region, locality), "US", "und", _country_note + " (leading)")
            leading_rows += 1

    print(f"#1104 country counterweight: {country_rows} tail + {leading_rows} leading rows")

    rng.shuffle(rows)
    dev_count = len(rows) // 10
    dev, train = rows[:dev_count], rows[dev_count:]

    args.out_parquet.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(train), args.out_parquet)
    args.out_dev.parent.mkdir(parents=True, exist_ok=True)

    with open(args.out_dev, "w", encoding="utf-8") as fh:
        for row in dev:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(f"slice: {len(train)} rows -> {args.out_parquet}")
    print(f"dev:   {len(dev)} rows -> {args.out_dev}")
