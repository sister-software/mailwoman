---
sidebar_title: Data Licensing
title: Data licensing & provenance
sidebar_position: 3
hide_footer: true
---

# Data licensing & provenance

The [code licensing](./index.md) pages cover the engine: AGPL or commercial. This page covers the
**data**, where Mailwoman's gazetteer comes from, the license each source carries, and the one boundary
that needs your attention before you ship anything OSM-derived.

The short version: the core gazetteer is built entirely from permissive sources, so a resolved coordinate
carries no copyleft. One optional precision tier (OpenStreetMap rooftop) is share-alike, and it is walled
off from the core so its obligations never leak into the default product.

:::caution[Legal sign-off: ☐ not cleared (as of 2026-06-30)]

The OpenStreetMap precision tier is **built but not enabled** in any published artifact — not on npm, not
on R2, not in the demo. Turning it on is gated on counsel reviewing the [questions
below](#what-counsel-needs-to-confirm). When that review lands, flip this to **☑ cleared**, name the
reviewing counsel, and date it.

:::

## Where the data comes from

Every source below is recorded with its license at the point it enters the pipeline. The authoritative
catalog is [`address-data-sources.mdx`](../plan/reference/address-data-sources.mdx); the legal notices ship as `THIRD_PARTY_NOTICES.md` in the source distribution, and each
built data artifact carries its own `ATTRIBUTION.json` recording source, release, and license
at build time.

| Source                 | License             | Obligation                                     | Role in Mailwoman                                                                |
| ---------------------- | ------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| Who's On First (WOF)   | CC0                 | none (public domain)                           | the gazetteer anchor — every place keeps its WOF id                              |
| US Census TIGER        | Public Domain       | none                                           | US street interpolation + the situs rooftop base                                 |
| Overture               | CDLA-Permissive-2.0 | attribution                                    | US address points; coverage centroids                                            |
| OpenAddresses          | per-source, varies  | per-source attribution / share-alike           | US gap states (e.g. Hawaii); cross-checked centroids                             |
| GeoNames               | CC-BY 4.0           | attribution                                    | the village-level + bilingual alt-name coverage fold                             |
| France BAN             | Licence Ouverte 2.0 | attribution (we elect this over its dual ODbL) | FR rooftop + street tiers (26M address points) and the FR street training corpus |
| **OpenStreetMap**      | **ODbL**            | **attribution + share-alike**                  | **optional** non-US rooftop shards — quarantined (below)                         |
| libpostal dictionaries | MIT                 | attribution                                    | bundled normalization data (`core/data/`)                                        |
| libaddressinput        | Apache-2.0          | attribution                                    | bundled format rules (`core/data/`)                                              |

The deliberate design choice is in the first row: **WOF is the anchor and the eval key**, and supplemental
data attaches as attributes on WOF-keyed entities, never as imported foreign-id records. That keeps the
permissive license of the core intact even as coverage grows.

## The ODbL boundary

OpenStreetMap is licensed under the [ODbL](https://opendatacommons.org/licenses/odbl/), which is share-alike
**on a Derivative Database** but draws a line at what it calls a _Produced Work_. That line is the whole game
for a geocoder, so it's worth stating precisely:

- A **Derivative Database** is a database built from ODbL data; for Mailwoman, that's the OSM rooftop shard
  (`address-points-<cc>-<slug>.db`). Redistributing one carries the full ODbL obligation: attribution,
  share-alike, and keeping it open.
- A **Produced Work** is something _algorithmically derived_ from the database that is not itself a database
  — a rendered map, a report, or (the case that matters here) a single resolved coordinate handed back from
  a lookup. ODbL does **not** impose share-alike on a Produced Work; it asks only for attribution.

So the working position, the one counsel needs to confirm, is that **serving a resolved coordinate is a
Produced Work** (attribution, no copyleft), while **distributing the shard itself is a Derivative Database**
(full ODbL). The architecture is built around that distinction holding.

## How the boundary is enforced

The quarantine is structural, not a runtime flag you could forget to set. Four mechanisms keep ODbL data
from reaching the permissive core:

1. **Per-row provenance.** Every address point carries a `source` string
   ([`address-point-schema.ts:41`](https://github.com/sister-software/mailwoman/blob/main/resolver-wof-sqlite/address-point-schema.ts)).
   OSM points are stamped `openstreetmap:<cc>` ([`build-rooftop-shard.ts:88`](https://github.com/sister-software/mailwoman/blob/main/osm/scripts/build-rooftop-shard.ts));
   permissive points are `overture:*` or `openaddresses`. License is attributable down to the row.

2. **The core never folds an OSM byte.** OSM points live in their own shards beside the WOF-keyed
   gazetteer, never merged into it. The `@mailwoman/osm` workspace is **code only**, so it contains no OSM
   data and depending on it carries no obligation.

3. **The tier is dark by default.** The cascade reaches the OSM shards only through an _optional_ injected
   dependency (`osmShards?` in [`geocode-core.ts:86`](https://github.com/sister-software/mailwoman/blob/main/mailwoman/geocode-core.ts)),
   consulted only for a non-US parse with no US situs match. The default product never injects it, so the
   tier does not exist unless a caller deliberately wires it in.

4. **The corpus refuses share-alike.** Training data is filtered through
   [`SHARE_ALIKE_PATTERN`](https://github.com/sister-software/mailwoman/blob/main/corpus/src/license.ts)
   (`--exclude-share-alike`), so no ODbL row can land in a proprietary weight build. Where a source is
   dual-licensed (France BAN), we elect the permissive option.

## Attribution: required, and not yet wired

ODbL requires attribution wherever the data is used. For Mailwoman that means **"© OpenStreetMap
contributors"** with an ODbL link, on:

- any geocoding result that resolved through an OSM shard, and
- the distribution of any shard itself (a `LICENSE` + attribution file alongside the `.db`).

Three gaps stand between today and that being true. They are prerequisites for enabling the tier, not
afterthoughts:

- The Nominatim-compatible `licence` string
  ([`nominatim/index.ts:307`](https://github.com/sister-software/mailwoman/blob/main/nominatim/index.ts))
  credits WOF, Overture, OpenAddresses, and TIGER — **it omits OpenStreetMap.** It needs an ODbL clause that
  appears whenever an OSM-sourced result is returned.
- The public `GeocodeResult`
  ([`geocode-core.ts`](https://github.com/sister-software/mailwoman/blob/main/mailwoman/geocode-core.ts))
  has **no field to carry per-result attribution** — the `source` reaches the resolver node metadata but is
  dropped before the result is returned. Surfacing ODbL attribution per result requires adding that field
  first.
- `THIRD_PARTY_NOTICES.md` credits OSM only as reaching us _via WOF and Overture_ (development-time). When
  first-party OSM shards ship, it needs a new entry for the `@mailwoman/osm` distribution. We hold that edit
  until the shards actually ship — adding it sooner would document a distribution that isn't happening.

(The note in [`osm/README.md`](https://github.com/sister-software/mailwoman/blob/main/osm/README.md) that
"the resolver surfaces © OpenStreetMap contributors on any result that resolved through one" describes the
target state, not the current one. The `source` tag rides as far as the resolver node; it is not yet emitted
to a user.)

## What counsel needs to confirm

The sign-off gate is these questions:

1. **Produced Work vs Derivative Database.** Does serving a single resolved coordinate from an OSM shard
   constitute a Produced Work (attribution only), as assumed above — or a Derivative Database hand-off
   (share-alike)? This determines whether API consumers inherit any obligation.
2. **The opt-in-per-country distribution.** Each shard is a separately-downloaded, per-country artifact, and
   the downloader takes the share-alike obligation only on the countries they pull. Does that distribution
   model satisfy ODbL, and what attribution + license file must ship beside each `.db`?
3. **The attribution surface.** Is "© OpenStreetMap contributors (ODbL)" on the result and in the shard
   distribution sufficient, and where exactly must it appear (per-result, per-session, in the docs)?

When these are answered, build the three attribution prerequisites above, flip the sign-off banner, and the
tier can ship. Until then, the build and the local benchmark are fine to run; **publishing is blocked.**

## See also

- [`osm/README.md`](https://github.com/sister-software/mailwoman/blob/main/osm/README.md) — the OSM package, the shard builder, the boundary in package terms.
- [`address-data-sources.mdx`](../plan/reference/address-data-sources.mdx) — the full source catalog + the licensing gradient.
- [`THIRD_PARTY_NOTICES.md`](https://github.com/sister-software/mailwoman/blob/main/THIRD_PARTY_NOTICES.md) — the formal notices shipped with the package.
- [Open-source license](./open-source.md) · [Commercial license](./commercial.md) — the engine's terms.
