---
sidebar_title: Data products
title: Database products catalog
sidebar_position: 3.5
hide_footer: true
---

# Database products catalog

Mailwoman consists of an engine and a set of databases. The engine is one npm install, and its terms are on the [licensing overview](./index.md). The databases are separate artifacts with their own provenance, sizes, and terms. Their terms differ because each database inherits obligations from the public register it was compiled from, which often surprises people.

This page lists the databases, with one entry per artifact. Each entry covers what the artifact contains, where the data came from, what the upstream license requires, whether we distribute the artifact or ship you the builder, and how current it is. If you are deciding what to load into a product, read this page alongside [data licensing & provenance](./data-provenance.md), which covers the same sources from the legal side.

## How to read an entry

**Tier** describes how the artifact is distributed. The [spatial-layer interface](https://github.com/sister-software/mailwoman/blob/main/docs/engineering/reference/layer-interface.mdx#tiers) defines the tiers, and this page applies them to every artifact, including those that do not formally embed the layer manifest:

- **shipped**: built only from permissive sources. We build and publish it.
- **build-local**: built from share-alike or otherwise unpublishable sources. We ship the **builder**, you run it on your own disk, and we distribute no data.
- **private**: your own data, conforming to the same schema, loaded from `$MAILWOMAN_DATA_ROOT`. It never leaves your machine.
- **planned**: designed but not built. These entries show the roadmap and are marked so that nobody depends on them.

**Cadence** describes current practice rather than a goal. Most of these artifacts are rebuilt when coverage changes or an ingest bug is fixed. They have no fixed schedule. Each entry states when that is the case.

Every artifact is a **sealed** SQLite file. It is built to a temp path, verified, swapped into place, and then set to `chmod 0444`. Updates are full rebuilds. None of these artifacts is a live database you write to.

## The shelf at a glance

| Product                                                                                             | What it answers                          | Tier          | Upstream license            |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------- | --------------------------- |
| [Admin gazetteer](#admin-gazetteer--candidatedb) (`candidate.db`)                                   | name → place, worldwide                  | shipped       | permissive mix (see entry)  |
| [WOF source gazetteer](#wof-source-gazetteer--admin-global-prioritydb) (`admin-global-priority.db`) | the build input behind the above         | internal      | permissive mix              |
| [POI layer](#poi-layer--poidb) (`poi.db`)                                                           | "coffee near X", category + brand search | shipped       | CDLA-Permissive-2.0         |
| [US situs extracts](#us-situs-extracts--address-points-us-stdb)                                     | US address → rooftop coordinate          | shipped       | public domain + open data   |
| [US interpolation extracts](#us-interpolation-extracts--interpolation-us-stdb)                      | US address → estimated coordinate        | shipped       | public domain               |
| [FR situs extract](#fr-situs-extract--address-points-frdb) (BAN)                                    | French address → rooftop coordinate      | shipped       | Licence Ouverte 2.0         |
| [OSM rooftop extracts](#osm-rooftop-extracts--address-points-cc-slugdb)                             | non-US address → rooftop coordinate      | build-local   | ODbL                        |
| [Timezone lookup](#timezone-lookup--timezonedb) (`timezone.db`)                                     | coordinate → IANA timezone               | build-local   | ODbL                        |
| [UN/LOCODE lookup](#unlocode-lookup--un-locodedb) (`un-locode.db`)                                  | place → trade-location code              | build-local   | public domain               |
| [NUTS lookup](#nuts-lookup--nutsdb) (`nuts.db`)                                                     | EU coordinate → statistical region       | build-local   | undetermined                |
| [Neural weights bundles](#neural-weights-bundles)                                                   | the parser itself                        | shipped (npm) | AGPL-3.0-only OR commercial |
| [Broadband filings](#broadband-filings--bdcdb-planned) (`bdc.db`)                                   | who filed what service where             | planned       | US public record            |

Each entry gives sizes and counts. They are the numbers this repository records, dated where the repository dates them, and a rebuild changes them.

---

## Admin gazetteer — `candidate.db`

Every other artifact depends on this one. Given a place name, it returns a coordinate, an administrative hierarchy, and a stable id.

**Contents.** A `WITHOUT ROWID` B-tree keyed on a normalized name, so one resolve is a single contiguous lookup rather than a full-text search. A browser session makes about 12 range fetches, compared with roughly 243 on the full database. An FTS5-trigram fuzzy index sits beside it. The resolver consults the fuzzy index **only** when the exact name misses, so `Manchestr` finds Manchester without slowing down exact matches. The artifact declares its own coverage in `country_coverage` and `country_bbox` tables.

**Upstream sources**, per the build log for the 2026-07-07 build
([`scripts/wof-build-manifest.json`](https://github.com/sister-software/mailwoman/blob/main/scripts/wof-build-manifest.json)):

| Source                                                                 | Rows folded          | License                                         | Obligation              |
| ---------------------------------------------------------------------- | -------------------- | ----------------------------------------------- | ----------------------- |
| Who's On First                                                         | 1,806,696            | see the note below                              | disputed in-repo        |
| Overture Maps `divisions` (release 2026-06-17.0)                       | 1,871,483            | CDLA-Permissive-2.0                             | attribution             |
| GeoNames                                                               | 772,507              | CC-BY 4.0                                       | attribution             |
| Census ZCTA 2024, GeoNames postal, Overture-derived postcode centroids | postcode layers      | public domain / CC-BY 4.0 / CDLA-Permissive-2.0 | attribution where CC-BY |
| chromium-i18n libaddressinput                                          | region abbreviations | Apache-2.0                                      | attribution             |

:::caution[The WOF license is recorded inconsistently in this repository]

[Data licensing & provenance](./data-provenance.md) and the address-data-sources reference both
say **CC0**. [`resolver-wof-sqlite/README.md`](https://github.com/sister-software/mailwoman/blob/main/resolver-wof-sqlite/README.md)
and the Hugging Face dataset card both say **CC-BY 4.0** and ask for an attribution notice.
`THIRD_PARTY_NOTICES.md` says WOF draws on several sources with their own licenses. These statements cannot all be right, and the answer decides whether the gazetteer carries a standing attribution obligation. Until the question is settled, attribute Who's On First to be safe. It is tracked as an item to resolve before shipping on the Lite artifact line.

:::

**Tier:** shipped. It is published to Cloudflare R2 and served from `https://public.mailwoman.ai/mailwoman/gazetteer/<version>/candidate.db`. The docs demo loads it directly with byte-range requests, so the demo uses the same artifact you would.

**Version / cadence.** The demo currently serves `2026-07-07a`. The path is dated and immutable, so every rebuild gets a new URL. There is **no fixed rebuild schedule**. The gazetteer is rebuilt when locale coverage is added or a source-ingest bug is fixed.

**Approximate size.** ~1.39 GB for the 2026-07-07 build, with 12,160,584 rows across 244 countries. An earlier note in `RELEASING.md` records ~490 MB, from before the postcode and GeoNames folds.

**Build.** `mailwoman gazetteer release` runs fold, build, promote, publish, and the demo version bump in one command. Each stage can also be run separately.

---

## WOF source gazetteer — `admin-global-priority.db`

This is the canonical local build that `candidate.db` is derived from. It is listed here because the FST priors and every offline eval read it, and because the repository contains a Hugging Face dataset card for it.

**Contents.** Tables `spr` (one row per place), `names` (multi-language variants), `concordances` (cross-source ids), `place_population`, and `ancestors`, plus a `place_search` FTS5 index and a separately built `place_bbox` R\*Tree. It is deliberately **not** the off-the-shelf geocode.earth WOF dump. Those dumps assign different WOF ids to the same place, which would break every id we have published.

**Tier:** internal. It is not part of the npm release and is not currently published anywhere. Its published derivative is `candidate.db` above.

:::note[The Hugging Face dataset card is stale]

[`hf-publish/mailwoman-wof-gazetteer/README.md`](https://github.com/sister-software/mailwoman/blob/main/hf-publish/mailwoman-wof-gazetteer/README.md)
describes a **1.09 GB, seven-country** build with 1,288,749 places and seven FST binaries. It was
last touched on 2026-05-28, at package version 0.5.4, and every number in it is a snapshot of that
date. The current build is global (244 countries) and only four FST locales are still produced.
Treat the card as history rather than as a description of anything you can download today.

:::

---

## POI layer — `poi.db`

This is layer #1 on the [spatial-layer interface](https://github.com/sister-software/mailwoman/blob/main/docs/engineering/reference/layer-interface.mdx), and later layers follow it as the worked example. It answers category and brand queries, such as "coffee near Springfield IL", rather than address queries.

**Contents.** 13,681,698 Overture Places rows at confidence ≥ 0.85 (US 11.52M, CA 794k, FR 721k, MX 644k). The rows are clustered on `(h3_cell, category_id, neg_rank, rowid_key)` in a `WITHOUT ROWID` B-tree, so a neighborhood query is one contiguous range read. H3 cells are res 9, matching `ADDRESS_H3_RESOLUTION` in `@mailwoman/address-id`, so a POI-to-address join compares keys without cell arithmetic. The artifact also has an FTS5 name index, a brand table, and 159,702 res-6 coverage cells.

**Upstream source.** Overture Maps Foundation, Places theme, release 2026-05-20.0. **License:** CDLA-Permissive-2.0. **Attribution:** "Overture Maps Foundation". The attribution is recorded in the layer manifest, so the obligation travels with the file.

**Tier:** `shipped`, which the builder writes into the manifest. Published to R2 at `https://public.mailwoman.ai/mailwoman/poi/<version>/poi.db`.

**Version / cadence.** Currently `2026-07-20a`. `freshness_policy = sealed` means updates are full rebuilds rather than in-place refreshes. Rebuilds are meant to follow Overture's release cadence, but no schedule is committed.

**Approximate size.** 3.7 GB sealed.

**Build.** `mailwoman gazetteer build poi --countries US,CA,MX,FR`. The [POI layer runbook](https://github.com/sister-software/mailwoman/blob/main/docs/engineering/reference/poi-layer-runbook.mdx) is the full build/verify/publish procedure, including the Overture schema problems that first-time builders usually hit.

:::info[The ODbL half of POI is a different artifact]

Infrastructure categories such as fiber huts, telephone exchanges, and street cabinets have no permissive source. They exist in OpenStreetMap and in Overture's `base` theme, both ODbL, and Overture's distribution does not remove OSM's license terms. A **second**, `build-local` POI layer is therefore built from OSM, separate from this shipped `poi.db`. Queries that need infrastructure abstain with `requires_build_local_layer` instead of guessing. We ship that layer's builder but not its output.

:::

---

## US situs extracts — `address-points-us-<st>.db`

This is the precision tier for the United States. It returns an exact building coordinate, rather than a street estimate or a city centroid.

**Contents.** One `address_point` table per state. Each row has the normalized and raw street, house number, unit, postcode, normalized locality, and coordinate. For licensing, the important fields are the per-row `source` string and source release. The extracts hold 124.9 million points across 50 per-state files.

**Upstream sources.** Overture's Addresses theme, which for the US combines the National Address Database (68%, US public domain) and OpenAddresses (32%, government open data). A 2026-06-14 measurement found **zero** OpenStreetMap/ODbL rows in the US set, so the build applies no license filter by default. Per-row provenance is `overture:<dataset>` or `openaddresses`.

**Obligation.** Attribution. NAD is public domain and requires no attribution, and the named OpenAddresses sources require credit. `mailwoman situs attribution-manifest` regenerates an `ATTRIBUTION.json` from the extracts on disk. Pass that document to your downstream users.

**Tier:** shipped. The extracts are served with byte-range requests from R2 at `https://public.mailwoman.ai/mailwoman/street/us/<slug>/situs.db` for 52 slugs: all 50 states plus DC and the US Virgin Islands.

**Version / cadence.** Release `2026-05-20.0`, pinned per artifact family in a `releases.json` manifest at the data root. There is no fixed rebuild schedule.

**Approximate size.** Size varies widely by state population. The only figure this repository records is DC, at 119,889,920 bytes (~114 MB). A demo lookup against it reads about 280 KB of that file, which is why the extracts are served with byte-range requests.

**Coverage gaps worth knowing.** Hawaii is built from OpenAddresses (348K rooftop points) because the primary source does not cover it. New Hampshire has **no** rooftop source and resolves at street level through interpolation only.

**Build.** `mailwoman situs address-points --state VT` builds one state, and `mailwoman situs build` builds all states.

---

## US interpolation extracts — `interpolation-us-<st>.db`

This is the fallback below the situs tier. Where no rooftop point exists, the resolver estimates the coordinate from the street segment's house-number range. An exact situs point always takes precedence over interpolation.

**Contents.** A `street_segment` table with one row **per side** of each road edge that carries addresses, because the source gives each side its own number range and ZIP. Each row also has parity, county FIPS, and the segment geometry as GeoJSON text. The extracts cover all 3,143 counties of the contiguous US.

**Upstream source.** US Census TIGER/Line 2023 EDGES shapefiles. **License:** public domain.
**Obligation:** none.

**Tier:** shipped. Hosted at
`https://public.mailwoman.ai/mailwoman/street/us/<slug>/interp.db`.

**Version / cadence.** Release `TIGER2023`. TIGER publishes annually, and the extracts are rebuilt when we adopt a new vintage.

**Approximate size.** This repository does not record per-state sizes.

**Build.** `mailwoman situs interpolation-extract --state VT` builds one state, and `mailwoman situs interpolation` downloads and builds all states.

**Related.** The `@mailwoman/tiger` workspace also builds `tiger.db`, which holds tabulation blocks, places, street features, and the 2020 P.L. 94-171 redistricting table. It is a corpus and demographics input rather than a resolver artifact. It is build-local and public domain, and `mailwoman tiger fetch --state <FIPS>` builds it.

---

## FR situs extract — `address-points-fr.db`

This is France's national address register in the same situs schema as the US extracts, so the resolver reads it without code changes.

**Contents.** 26 million address points across 101 départements. A companion `street-centroids-fr.db` aggregates the same register into 2.2M street-level rows with centroid, bounding box, and member-point count, for street-only queries.

**Upstream source.** Base Adresse Nationale, from `adresse.data.gouv.fr`, release 2026-05-18.

**License.** **Licence Ouverte / Open Licence 2.0 (Etalab)**, which requires attribution only and has **no share-alike** clause. BAN is dual-licensed and we elect the permissive option. The extract therefore ships under the same terms as the permissive core and needed no counsel check.

**Attribution.** "© les contributeurs de la Base Adresse Nationale (adresse.data.gouv.fr)". It is carried per row as `source = ban:fr` and recorded in `ban/ATTRIBUTION.json` with the source URL, release, row count, and md5 at build time.

**Tier:** shipped. Hosted at `https://public.mailwoman.ai/mailwoman/street/fr/<version>/situs.db`, currently `2026-07-10` (the rebuild that fixed quoting and folded arrondissements).

**Approximate size.** 6.9 GB sealed.

**Build.** `node ban/out/scripts/build-address-point-extract.js --csv-dir <dir> --release 2026-05-18`. The `--depts` flag builds a temporary sample to validate first.

**Not included.** France has no interpolation extract. The exact-point tier covers France, and house numbers that BAN does not carry are not interpolated.

---

## OSM rooftop extracts — `address-points-<cc>-<slug>.db`

These extracts provide rooftop coverage for countries without a permissive national register. They are complete and benchmarked, and **we do not distribute them**.

**Contents.** The same situs schema, built from address points: the exact `addr:housenumber` coordinate of a node, or the centroid of a building polygon. Interpolation is deliberately excluded. The build reads only OSM's explicit `addr:interpolation` ways and never synthesizes a house-number line from scattered points. Street locales exist for FR, DE, and NL.

Measured extracts, from the 2026-06-29 build session:

| Extract                            | Points       | Size         | Street-association gap |
| ---------------------------------- | ------------ | ------------ | ---------------------- |
| DE / Berlin                        | 450,900      | 108 MB       | 0.3%                   |
| NL / national                      | 9,919,996    | 2.3 GB       | 0.0%                   |
| FR (with nearest-highway recovery) | 477k → 1.13M | not recorded | 58% → 1.3%             |

**Upstream source.** Geofabrik PBF extracts of OpenStreetMap. **License:** ODbL, which requires attribution **and** share-alike on a Derivative Database.

**Tier:** build-local, and specifically **publish-blocked**. No OSM extract ships to npm, R2, or the public demo until counsel has reviewed how ODbL share-alike applies to this distribution model. The `@mailwoman/osm` workspace contains **only code** and no OSM data, so depending on it carries no obligation. You can build and benchmark locally today, but you cannot publish.

[Data licensing & provenance](./data-provenance.md#the-odbl-boundary) lists the three open questions and the four structural mechanisms that keep ODbL data out of the permissive core.

**Build.** `node osm/out/scripts/build-rooftop-extract.js --country fr --slug idf --release <tag> --pbf <file>`. It requires GDAL's `ogr2ogr` on PATH.

---

## Timezone lookup — `timezone.db`

**Contents.** A single `timezone_polygons` table with one row per boundary feature. Each row has the IANA tzid, a bounding box for the prefilter, and MultiPolygon coordinates as JSON. Point-in-polygon lookup runs on `node:sqlite`, server-side only.

**Upstream source.** The `combined-with-oceans.json` release artifact of [timezone-boundary-builder](https://github.com/evansiroky/timezone-boundary-builder). The repository does not pin an upstream release.

**License.** **ODbL.** Attribution and share-alike apply to the database you build and distribute.

**Tier:** build-local. `@mailwoman/timezone-lookup` is published to npm at 8.3.0. It ships the builder and the reader, but not a `.db`.

**Approximate size / row count.** Not recorded. The build prints a feature count at runtime, and no step saves it.

**Build.**
`npx @mailwoman/timezone-lookup build --geojson combined-with-oceans.json --out timezone.db`.
Walkthrough: [looking up a timezone](../recipes/timezones.md).

---

## UN/LOCODE lookup — `un-locode.db`

**Contents.** A single `un_locode` table with one row per assigned location. Each row has the country, location code, name, normalized name, and coordinates where the source provides them. The table supports exact lookup by name and nearest-code lookup by coordinate.

**Upstream source.** The UNECE UN/LOCODE code list (`code-list.csv`). The repository records no URL or release.

**License.** The repository describes it as a **public domain** code list without a share-alike obligation. It gives no formal identifier, CC0 or otherwise.

**Tier:** build-local. `@mailwoman/un-locode-lookup` is published to npm at 8.3.0, and the `.db` is not published.

**Row counts.** 116k entries, of which roughly 93k have coordinates. An older docstring in the package says about a third have coordinates. Use the README and recipe figures given here.

**Build.** `npx @mailwoman/un-locode-lookup build --csv code-list.csv --out un-locode.db`.
Walkthrough: [UN/LOCODE lookup](../recipes/un-locode-lookup.md).

---

## NUTS lookup — `nuts.db`

**Contents.** A single `nuts_regions` table with one row per region: its NUTS id, level, bounding box, and geometry. It covers levels 1–3 and queries outward from the finest level, which matches the shape OpenCage returns.

**Upstream source.** [Eurostat GISCO](https://ec.europa.eu/eurostat/web/gisco) NUTS boundaries, from a `NUTS_RG_*_4326.geojson` export. No vintage is pinned.

**License.** **Not determined.** The repository records only an attribution string, "© EuroGeographics for the administrative boundaries", and no license identifier. Until the actual terms are established, treat redistribution of a built `nuts.db` as an open question.

**Tier:** build-local. `@mailwoman/nuts-lookup` is published to npm at 8.3.0.

**Approximate size / row count.** Not recorded.

**Build.** `npx @mailwoman/nuts-lookup build --geojson NUTS_RG_03M_2021_4326.geojson --out nuts.db`.

---

## Neural weights bundles

These packages are the parser itself, distributed as data-only npm packages that `@mailwoman/neural` loads at runtime. Unlike everything else on this page, they ship on npm rather than R2, and they are a **first-party artifact**. We trained them, so we set their license.

**License.** `AGPL-3.0-only OR LicenseRef-Commercial`, the same dual license as the engine. The Hugging Face READMEs list only the AGPL half. The `package.json` and model card carry the dual form and are authoritative.

| Package                               | Role                         | npm   | Unpacked |
| ------------------------------------- | ---------------------------- | ----- | -------- |
| `@mailwoman/neural-weights-en-us`     | the self-contained base      | 8.3.0 | ~72 MB   |
| `@mailwoman/neural-weights-en-gb`     | data-only overlay            | 8.3.0 | ~12 MB   |
| `@mailwoman/neural-weights-fr-fr`     | data-only overlay            | 8.3.0 | ~17 MB   |
| `@mailwoman/neural-weights-en-nz`     | data-only overlay            | 8.3.0 | ~8 MB    |
| `@mailwoman/neural-weights-base-latn` | parked rather than published | 7.8.1 | —        |

**Contents.** The en-US package carries the model (`model.onnx`), the SentencePiece tokenizer, the model card, calibration tables, the US postcode FST, the en-US and street-morphology FST gazetteer priors, and four evidence lexicons. The overlays share the base's byte-identical model and tokenizer. Each overlay ships only its locale-specific files: a postcode FST, a locale FST, and, where the locale has one, a `pair-index-<cc>.bin` placetype-pair index (GB: 19,209 pairs, ~458 KB; NZ: 3,134 pairs, ~55 KB).

**Model.** Version 7.0.0, the base trained from scratch. It is ONNX int8, dynamically quantized from fp32, with opset 17, max sequence 128, six layers at hidden size 384, vocabulary 73,143, and roughly 29M parameters. It is **37.6 MB int8** (146.6 MB fp32). The en-US package README prints older size and vocabulary figures. `model-card.json` is the authoritative source.

**Training data.** The corpus is compiled only from permissive sources by construction. The corpus build filters share-alike rows through `SHARE_ALIKE_PATTERN` (`--exclude-share-alike`). The model card's attribution list names HM Land Registry PPD (OGL v3.0), LINZ-derived OpenAddresses NZ (CC-BY 4.0), BAN (Licence Ouverte 2.0), Overture Addresses (CDLA-Permissive-2.0), and several per-country OpenAddresses sets. **No ODbL source appears.** The CC-BY and OGL sources carry real attribution obligations, which travel with the model card.

**Tier:** shipped, on two backends that must agree. npm hosts the packages, and the public Hugging Face bucket `sister-software/mailwoman` hosts the binaries that the CI publish job downloads.

**Cadence.** No cadence is committed. Versions are lockstep: every workspace, including the weights, shares one version per release. A weights package version therefore tracks the release number rather than the model's own lineage. Most releases change only code. Promoting a newly trained model to the default is a deliberate, larger operation. The model's own identity is recorded in `model_lineage` on the card.

**Note on card drift.** The overlay model cards are not bumped automatically at release, so their `version` fields lag the base. Read `model_lineage` and `files_md5` rather than the overlay card's version number.

---

## Broadband filings — `bdc.db` (planned)

**Status: designed but not built.** This is Phase 2a of the broadband-plausibility vertical. It is listed so the design is public. No artifact is available to download.

**Intended contents.** FCC Broadband Data Collection availability filings at census-block grain. Each row would have the provider id, technology code, advertised up/down speeds, latency flag, business/residential code, the 15-character block GEOID, and the Fabric BSL `location_id` as an **opaque join key only**. The spine keys would be `wof_id` and res-9 `h3` from the block centroid. They would deliberately **not** include `address_id`, because a block-grained filing does not describe an individual address. Any per-address answer would be an inference across the block and flagged as such.

**Upstream source.** FCC BDC availability data, a US government public record in the public domain.

**Intended tier.** Candidate for shipped. The open problem is size, because the public-domain source leaves no licensing question. A nationwide fixed-broadband vintage has on the order of 10⁸ rows. The likely result is a shipped pilot-state subset with build-local for the rest, following the POI layer's approach of piloting before scaling.

**Intended cadence.** `versioned-refresh`: re-issued under the same name for each BDC vintage, with each issue sealed. The `as_of_date` would be carried as `source_vintage` and reported on every answer. Filing data is always valid only as of a specific vintage.

**The fixed boundary.** The CostQuest Fabric, the licensed map from BSL id to a precise rooftop point, is **never ingested, shipped, or used to derive data**. All spatial work happens at public block granularity plus the address spine we already own.

---

## What is not on this shelf

- **Build inputs.** Postcode extracts, `tiger.db`, the durable GeoNames alias fold, and the raw Overture parquet extracts are intermediates that feed the artifacts above. The build runbooks document them.
- **Demo assets.** The map-highlight polygons and the address-coverage tile overlay exist for the demo. See the [coverage overlay runbook](https://github.com/sister-software/mailwoman/blob/main/docs/engineering/reference/coverage-overlay.mdx).
- **Your data.** A `private`-tier layer that conforms to the same interface, such as a CRM export, survey notes, or parcel relationships, can be queried the same way and never leaves your machine. We support this use but do not sell it as a product.

## See also

- [Data licensing & provenance](./data-provenance.md): the per-source license table, the ODbL boundary, and what counsel still needs to confirm.
- [Pricing](./pricing.mdx): the engine's tiers, and the [OEM band](./pricing.mdx#embedding-mailwoman-in-a-product-you-sell) for shipping Mailwoman inside a product you license to others.
- [Spatial-layer interface](https://github.com/sister-software/mailwoman/blob/main/docs/engineering/reference/layer-interface.mdx): the schema every layer database embeds, and the source of the tier vocabulary on this page.
- [POI layer runbook](https://github.com/sister-software/mailwoman/blob/main/docs/engineering/reference/poi-layer-runbook.mdx): the worked build/verify/publish example.
- [Data, locales, and coverage](../concepts/data-locales-and-coverage.mdx): the same layers, described by what they can and cannot resolve.
- [Address data sources](https://github.com/sister-software/mailwoman/blob/main/docs/engineering/reference/address-data-sources.mdx): the catalog of upstream registers and the range of their licenses.
- [Software Bill of Materials](./sbom.md): the code-side inventory, per release.
