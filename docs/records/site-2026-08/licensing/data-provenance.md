---
sidebar_title: Data Licensing
title: Data licensing & provenance
sidebar_position: 3
hide_footer: true
---

# Data licensing & provenance

The [code licensing](./index.md) pages cover the engine, which is AGPL or commercial. This page covers the **data**: where Mailwoman's gazetteer comes from, the license each source carries, and the one boundary to check before you ship anything derived from OSM.

The core gazetteer is built entirely from permissive sources, so a resolved coordinate carries no copyleft. One optional precision tier, OpenStreetMap rooftop, is share-alike. It is kept separate from the core so that its obligations never apply to the default product.

:::danger[Correction, 2026-09-27: the sentence above is contradicted by the artifact]

This page records the state as of 2026-08 and its text is left as it was written. The paragraph above no longer describes what the shipped `candidate` bundle contains, and a reader acting on it would be misinformed.

Measured 2026-09-27 from the artifacts themselves. The `candidate` bundle serves
`gazetteer/2026-08-25b/candidate.db` from `public.mailwoman.ai`, 2,880,921,600 bytes, last modified
2026-08-25. Its own `layer_manifest`, read over HTTP range requests, records `tier = build-local`,
`license = ODbL-1.0 AND CDLA-Permissive-2.0 AND CC-BY-4.0`, `source = admin-global-priority@2026-08-25`
and `build_sha = 2b9894111`.

The admin gazetteer that name refers to is not published, and the copy on the lab host is a later build
(`2026-09-15`). That later one records `whosonfirst+overture-divisions+geonames` as its sources with the
Overture Divisions release `2026-07-22.0`, and the builder that produced both folds Overture Divisions the
same way. Which Overture release reached the published 2026-08-25 chain is unmeasured. Overture's
attribution page gives its Divisions theme `License for theme: ODbL`.

So the core gazetteer reads a share-alike source, and this page says it does not. What the Open Database License then requires of a redistributor depends on whether the combination is a Derivative Database, a Collective Database, a Produced Work, or an extraction below the threshold the license sets. **That reading is with counsel and this correction states no conclusion about it.**

Both quantities that bear on the answer were measured on 2026-09-27, over the lab host's `2026-09-15`
chain. `spr` carries no source column, but each fold mints ids from its own base in
`@mailwoman/core/resolver/synthetic-id-ranges`, and the Overture fold writes only rows in
`[8e12, 9e12)` and updates no Who's On First row, so the range is an exact count rather than a floor.

Overture Divisions contributed **1,590,314 of the admin gazetteer's 4,921,635 `spr` rows, 32.31%**. All
1,590,314 survive into that chain's `candidate.db` as **1,590,314 of 8,714,235 distinct places, 18.25%**,
carrying 2,539,196 of its 16,307,416 candidate rows. The fields that survive are the primary name, every
`names.common` alias with its language, the placetype, the country, the label-point latitude and
longitude, the bounding box taken from the matching `division_area`, the parent division, the population
and the Wikidata concordance.

The GERS id does not survive. `fold-overture` writes a concordance under `wd:id` alone, so no row in
either artifact can be traced back to the Overture record it came from. Counsel should know that before
considering whether an alteration file is producible.

The same measurement over the published `2026-08-25` artifact was taken on 2026-09-27, after downloading it
in full. Overture Divisions contributes **1,590,314 of its 8,346,136 distinct places, 19.05%**, over
2,152,892 of its 15,183,707 candidate rows. The place count is identical in both chains.

The published artifact's expression covers the terms of three folds, which are 6,537,182 of 8,346,136
places, 78.33%. The remaining 1,808,954 places, 21.67%, come from folds the expression leaves out:
Code-Point Open at 1,746,976 places under the Open Government License v3.0, GeoNames postal at 57,221, and
the Northern Ireland OpenStreetMap fold at 4,757.

`packages/mailwoman/lib/data/bundles.ts` now names Overture Divisions among the bundle's publishers and carries the unresolved question. `refusalsForPublication` in `@mailwoman/core/layers` refuses to publish a layer whose `tier` or license expression forbids it, which catches this artifact.

:::

:::caution[Legal sign-off: ☐ not cleared (as of 2026-06-30)]

The OpenStreetMap precision tier is **built but not enabled** in any published artifact. It is not on npm, on R2, or in the demo. Enabling it is blocked until counsel reviews the [questions below](#what-counsel-needs-to-confirm). When that review is complete, change this banner to **☑ cleared**, name the reviewing counsel, and add the date.

:::

:::danger[Correction, 2026-09-27: a published artifact carries OpenStreetMap-derived rows]

This page records the state as of 2026-08 and its text is left as it was written. The banner above is
accurate about the tier it describes and inaccurate as a statement about the published gazetteer.

The banner is about the OpenStreetMap **rooftop address extracts** in `@mailwoman/osm`. Those remain absent
from every published artifact, and that part holds.

A second OpenStreetMap-derived layer reaches a published artifact by a different route. The Northern Ireland
unit-postcode database is built from OpenStreetMap `addr:postcode` tags, because Code-Point Open carves
Northern Ireland out and the alternatives were a £9,224 license or no postcode data. Its rows were folded
into the candidate gazetteer, which ships as the `candidate` bundle.

Measured 2026-09-27 by downloading the published artifact in full,
`gazetteer/2026-08-25b/candidate.db`, 2,880,921,600 bytes, and verifying the byte count against the
server's `content-length` before counting any row. It holds **4,757 places and 9,536 candidate rows** minted
from the Northern Ireland OpenStreetMap fold's own id range. Sampled rows read `BT11AA`, `BT11AL`, `BT11BL`,
`BT11DA` and `BT11DD` at Belfast coordinates. The place count matches that database's own documented figure
of 4,757 of the 50,032 live Northern Ireland postcodes, 9.5%.

So a reader who relied on this banner to conclude that the published gazetteer carries no share-alike data
was misinformed on that point. The artifact's own `layer_manifest` records `tier = build-local` and a license
expression including `ODbL-1.0`, so the file states its own terms correctly while this page does not.

**What the share-alike obligation then requires of a redistributor is with counsel, and this correction
states no conclusion about it.** The engineering options are recorded, and the choice between them is the
operator's.

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

:::danger[Correction, 2026-09-27: mechanism 4 above describes a flag that never existed]

This page records the state as of 2026-08 and its text is left as it was written. Mechanism 4 above cites
a command-line flag and a filter that a reader could not have used.

`--exclude-share-alike` was never a flag on `mw corpus build` or on any other command. Its underlying
option, `buildCorpus({ excludeLicenses })`, was reachable only from the library, and the only caller in
the repository was `packages/corpus/lib/build/index.test.ts`. No corpus was ever built with it.

`SHARE_ALIKE_PATTERN` was an anchored prefix match, `/^ODbL|^Open Database License|^CC-BY-SA|^CC-SA/i`,
over the row's `license` column. Measured over `v0.7.0-de-holdout` on 2026-09-26, that column holds 71
distinct values across 703,835,753 rows, of which 4 are SPDX identifiers covering 75,582,634 rows and 66
are prose covering 628,203,119, plus 50,000 rows at `null`. A row whose license reads "Synthetic —
OpenStreetMap venue + sub-venue names (ODbL, © OpenStreetMap contributors) …" is share-alike-derived and
begins with neither identifier, so the prefix match admitted it. 358,597 rows carry a license value of
that shape.

As of 2026-09-27 the decision reads the obligations recorded for a license expression rather than the
shape of its string. `mw corpus build --license-policy share-alike-free` refuses a row whose license
resolves to an expression carrying share-alike, and separately a row whose text cites a share-alike
license while stating no grant of its own. `mw corpus upload` refuses a corpus version whose license set
holds either class unless `--allow-share-alike` is passed. The corpus manifest records which policy ran,
how many rows each refusal class removed, and how many admitted rows carry a license resolving to no
expression, because unknown obligations are different from none.

The claim's second sentence still holds: the `ban` adapter stamps `Licence Ouverte 2.0`, which resolves to
`etalab-2.0` and carries attribution alone.

:::

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
