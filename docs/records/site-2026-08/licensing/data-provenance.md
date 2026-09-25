---
sidebar_title: Data Licensing
title: Data licensing & provenance
sidebar_position: 3
hide_footer: true
---

# Data licensing & provenance

The [code licensing](./index.md) pages cover the engine, which is AGPL or commercial. This page covers the **data**: where Mailwoman's gazetteer comes from, the license each source carries, and the one boundary to check before you ship anything derived from OSM.

The core gazetteer is built entirely from permissive sources, so a resolved coordinate carries no copyleft. One optional precision tier, OpenStreetMap rooftop, is share-alike. It is kept separate from the core so that its obligations never apply to the default product.

:::caution[Legal sign-off: ☐ not cleared (as of 2026-06-30)]

The OpenStreetMap precision tier is **built but not enabled** in any published artifact. It is not on npm, on R2, or in the demo. Enabling it is blocked until counsel reviews the [questions below](#what-counsel-needs-to-confirm). When that review is complete, change this banner to **☑ cleared**, name the reviewing counsel, and add the date.

:::

## Where the data comes from

Each source below is recorded with its license at the point it enters the pipeline. The authoritative catalog is [`address-data-sources.mdx`](https://github.com/sister-software/mailwoman/blob/main/docs/engineering/reference/address-data-sources.mdx). The legal notices ship as `THIRD_PARTY_NOTICES.md` in the source distribution. Each built data artifact carries its own `ATTRIBUTION.json`, which records the source, release, and license at build time.

| Source                 | License             | Obligation                                     | Role in Mailwoman                                                                |
| ---------------------- | ------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| Who's On First (WOF)   | CC0                 | none (public domain)                           | the gazetteer anchor — every place keeps its WOF id                              |
| US Census TIGER        | Public Domain       | none                                           | US street interpolation + the situs rooftop base                                 |
| Overture               | CDLA-Permissive-2.0 | attribution                                    | US address points; coverage centroids                                            |
| OpenAddresses          | per-source, varies  | per-source attribution / share-alike           | US gap states (e.g. Hawaii); cross-checked centroids                             |
| GeoNames               | CC-BY 4.0           | attribution                                    | the village-level + bilingual alt-name coverage fold                             |
| France BAN             | Licence Ouverte 2.0 | attribution (we elect this over its dual ODbL) | FR rooftop + street tiers (26M address points) and the FR street training corpus |
| **OpenStreetMap**      | **ODbL**            | **attribution + share-alike**                  | **optional** non-US rooftop extracts — quarantined (below)                       |
| libpostal dictionaries | MIT                 | attribution                                    | bundled normalization data (`core/data/`)                                        |
| libaddressinput        | Apache-2.0          | attribution                                    | bundled format rules (`core/data/`)                                              |

The first row records the deliberate design choice. **WOF is the anchor and the eval key.** Supplemental data attaches as attributes on WOF-keyed entities and is never imported as records with foreign ids. This keeps the core's permissive license intact as coverage grows.

## The ODbL boundary

OpenStreetMap is licensed under the [ODbL](https://opendatacommons.org/licenses/odbl/). The ODbL requires share-alike **on a Derivative Database** but treats what it calls a _Produced Work_ differently. For a geocoder, that distinction decides the obligations, so it needs a precise statement:

- A **Derivative Database** is a database built from ODbL data. For Mailwoman, that is the OSM rooftop extract (`address-points-<cc>-<slug>.db`). Redistributing one carries the full ODbL obligation: attribution, share-alike, and keeping it open.
- A **Produced Work** is something _algorithmically derived_ from the database that is not itself a database. Examples are a rendered map, a report, or, in the case that matters here, a single resolved coordinate returned from a lookup. ODbL does **not** impose share-alike on a Produced Work and requires only attribution.

Our working position, which counsel needs to confirm, is that **serving a resolved coordinate is a Produced Work** (attribution without copyleft), while **distributing the extract itself is a Derivative Database** (full ODbL). The architecture assumes that this distinction holds.

## How the boundary is enforced

The separation is built into the structure of the code and data, so it does not depend on a runtime flag that someone could forget to set. Four mechanisms keep ODbL data out of the permissive core:

1. **Per-row provenance.** Every address point carries a `source` string ([`address-point-schema.ts:41`](https://github.com/sister-software/mailwoman/blob/main/resolver-wof-sqlite/address-point-schema.ts)). OSM points are marked `openstreetmap:<cc>` ([`build-rooftop-extract.ts:88`](https://github.com/sister-software/mailwoman/blob/main/osm/scripts/build-rooftop-extract.ts)), and permissive points are `overture:*` or `openaddresses`. The license of every row can be identified.

2. **The core never includes OSM data.** OSM points live in their own extracts beside the WOF-keyed gazetteer and are never merged into it. The `@mailwoman/osm` workspace contains **only code** and no OSM data, so depending on it carries no obligation.

3. **The tier is off by default.** The cascade reaches the OSM extracts only through an _optional_ injected dependency (`osmExtracts?` in [`geocode-core.ts:86`](https://github.com/sister-software/mailwoman/blob/main/mailwoman/geocode-core.ts)). It consults them only for a non-US parse without a US situs match. The default product never injects the dependency, so the tier is absent unless a caller deliberately adds it.

4. **The corpus excludes share-alike data.** Training data is filtered through [`SHARE_ALIKE_PATTERN`](https://github.com/sister-software/mailwoman/blob/main/corpus/src/license.ts) (`--exclude-share-alike`), so no ODbL row can enter a proprietary weight build. Where a source is dual-licensed (France BAN), we elect the permissive option.

## Attribution: required, and not yet wired

ODbL requires attribution wherever the data is used. For Mailwoman, that means **"© OpenStreetMap contributors"** with an ODbL link on:

- any geocoding result that resolved through an OSM extract, and
- the distribution of any extract itself, as a `LICENSE` and attribution file beside the `.db`.

Three gaps remain before that is true. They must be closed before the tier is enabled:

- The Nominatim-compatible `licence` string ([`nominatim/index.ts:307`](https://github.com/sister-software/mailwoman/blob/main/nominatim/index.ts)) credits WOF, Overture, OpenAddresses, and TIGER, but **it omits OpenStreetMap.** It needs an ODbL clause that appears whenever a result comes from OSM.
- The public `GeocodeResult` ([`geocode-core.ts`](https://github.com/sister-software/mailwoman/blob/main/mailwoman/geocode-core.ts)) has **no field for per-result attribution**. The `source` reaches the resolver node metadata but is dropped before the result is returned. That field must be added before ODbL attribution can appear on each result.
- `THIRD_PARTY_NOTICES.md` credits OSM only as data that reaches us _via WOF and Overture_ (development-time). When first-party OSM extracts ship, it needs a new entry for the `@mailwoman/osm` distribution. We are holding that edit until the extracts ship, because adding it sooner would document a distribution that does not exist.

The note in [`osm/README.md`](https://github.com/sister-software/mailwoman/blob/main/osm/README.md) that "the resolver surfaces © OpenStreetMap contributors on any result that resolved through one" describes the target state. The current code has not reached it yet. The `source` tag reaches the resolver node but is not yet shown to users.

## What counsel needs to confirm

Sign-off requires answers to these questions:

1. **Produced Work vs Derivative Database.** Does serving a single resolved coordinate from an OSM extract constitute a Produced Work (attribution only), as assumed above, or the hand-off of a Derivative Database (share-alike)? The answer determines whether API consumers inherit any obligation.
2. **The opt-in-per-country distribution.** Each extract is a separately downloaded, per-country artifact, and the downloader takes on the share-alike obligation only for the countries they download. Does that distribution model satisfy ODbL, and what attribution and license file must ship beside each `.db`?
3. **The attribution surface.** Is "© OpenStreetMap contributors (ODbL)" on the result and in the extract distribution sufficient, and where exactly must it appear (per result, per session, in the docs)?

When these questions are answered, build the three attribution prerequisites above and update the sign-off banner. The tier can then ship. Until then, you can run the build and the local benchmark, but **publishing is blocked.**

## See also

- [Database products catalog](./data-products.md): the same sources from the artifact side, including what each shipped or planned database contains, its tier, its version, and its size.
- [`osm/README.md`](https://github.com/sister-software/mailwoman/blob/main/osm/README.md): the OSM package, the extract builder, and the boundary in package terms.
- [`address-data-sources.mdx`](https://github.com/sister-software/mailwoman/blob/main/docs/engineering/reference/address-data-sources.mdx): the full source catalog and the range of source licenses.
- [`THIRD_PARTY_NOTICES.md`](https://github.com/sister-software/mailwoman/blob/main/THIRD_PARTY_NOTICES.md): the formal notices shipped with the package.
- [Open-source license](./open-source.md) · [Commercial license](./commercial.md): the engine's terms.
