---
sidebar_title: Data products
title: Database products catalog
sidebar_position: 3.5
hide_footer: true
---

# Database products catalog

Mailwoman is an engine plus a shelf of databases. The engine is one npm install and its terms are
on the [licensing overview](./index.md). The databases are separate artifacts with separate
provenance, separate sizes, and — this is the part that surprises people — separate terms, because
each one inherits obligations from whatever public register it was compiled from.

This page is the shelf. One entry per artifact: what is in it, where the bytes came from, what the
upstream license asks of you, whether we distribute it or ship you the builder, and how current it
is. If you are deciding what to load into a product, read this alongside
[data licensing & provenance](./data-provenance.md), which covers the same sources from the legal
side rather than the artifact side.

## How to read an entry

**Tier** is the distribution posture, defined by the
[spatial-layer contract](../plan/reference/layer-contract.mdx#tiers) and used here for every
artifact, not just the ones that formally embed the layer manifest:

- **shipped** — permissive sources only. We build it and publish it.
- **build-local** — share-alike or otherwise unpublishable sources. We ship the **builder**; you
  run it on your own disk; we distribute nothing.
- **private** — your own data, conforming to the same schema, loaded from
  `$MAILWOMAN_DATA_ROOT`, never leaving your machine.
- **planned** — designed, not built. Listed so the roadmap is legible, marked so nobody plans
  around vapor.

**Cadence** is honest rather than aspirational. Most of these are rebuilt when coverage changes or
an ingest bug is fixed, not on a schedule. Where that is the case, the entry says so.

Every artifact is a **sealed** SQLite file: built to a temp path, verified, swapped into place,
then `chmod 0444`. Updates are full rebuilds. Nothing here is a live database you write to.

## The shelf at a glance

| Product                                                                                             | What it answers                          | Tier          | Upstream license            |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------- | --------------------------- |
| [Admin gazetteer](#admin-gazetteer--candidatedb) (`candidate.db`)                                   | name → place, worldwide                  | shipped       | permissive mix (see entry)  |
| [WOF source gazetteer](#wof-source-gazetteer--admin-global-prioritydb) (`admin-global-priority.db`) | the build input behind the above         | internal      | permissive mix              |
| [POI layer](#poi-layer--poidb) (`poi.db`)                                                           | "coffee near X", category + brand search | shipped       | CDLA-Permissive-2.0         |
| [US situs shards](#us-situs-shards--address-points-us-stdb)                                         | US address → rooftop coordinate          | shipped       | public domain + open data   |
| [US interpolation shards](#us-interpolation-shards--interpolation-us-stdb)                          | US address → estimated coordinate        | shipped       | public domain               |
| [FR situs shard](#fr-situs-shard--address-points-frdb) (BAN)                                        | French address → rooftop coordinate      | shipped       | Licence Ouverte 2.0         |
| [OSM rooftop shards](#osm-rooftop-shards--address-points-cc-slugdb)                                 | non-US address → rooftop coordinate      | build-local   | ODbL                        |
| [Timezone lookup](#timezone-lookup--timezonedb) (`timezone.db`)                                     | coordinate → IANA timezone               | build-local   | ODbL                        |
| [UN/LOCODE lookup](#unlocode-lookup--un-locodedb) (`un-locode.db`)                                  | place → trade-location code              | build-local   | public domain               |
| [NUTS lookup](#nuts-lookup--nutsdb) (`nuts.db`)                                                     | EU coordinate → statistical region       | build-local   | undetermined                |
| [Neural weights bundles](#neural-weights-bundles)                                                   | the parser itself                        | shipped (npm) | AGPL-3.0-only OR commercial |
| [Broadband filings](#broadband-filings--bdcdb-planned) (`bdc.db`)                                   | who filed what service where             | planned       | US public record            |

Sizes and counts appear in each entry. They are the numbers this repository records, dated where
the repository dates them; a rebuild moves them.

---

## Admin gazetteer — `candidate.db`

The one everything else leans on. Give it a place name and it gives you a coordinate, an
administrative hierarchy, and a stable id.

**Contents.** A `WITHOUT ROWID` B-tree keyed on a normalized name, so one resolve is a single
contiguous probe rather than a full-text search — about 12 range fetches per browser session
against roughly 243 on the full database. An FTS5-trigram fuzzy index sits beside it and is
consulted **only** on an exact-name miss, which is what makes `Manchestr` find Manchester without
slowing down the path that already worked. The artifact declares its own coverage through
`country_coverage` and `country_bbox` tables.

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
`THIRD_PARTY_NOTICES.md` says WOF draws on several sources with their own licenses. These cannot
all be right, and the difference decides whether the gazetteer carries a standing attribution
obligation. Until it is settled, the safe course is to attribute Who's On First. This is tracked
as a resolve-before-shipping item on the Lite artifact line.

:::

**Tier:** shipped. Published to Cloudflare R2 and served from
`https://public.sister.software/mailwoman/gazetteer/<version>/candidate.db`. The docs demo
byte-range-loads it directly, which is the same artifact you would.

**Version / cadence.** The demo currently serves `2026-07-07a`. The path is dated and immutable, so
a rebuild always gets a fresh URL. There is **no fixed rebuild schedule**: it is rebuilt when locale
coverage is added or a source-ingest bug is fixed.

**Approximate size.** ~1.39 GB for the 2026-07-07 build, at 12,160,584 rows across 244 countries.
(An earlier note in `RELEASING.md` records ~490 MB; that predates the postcode and GeoNames folds.)

**Build.** `mailwoman gazetteer release` runs fold, build, promote, publish, and the demo version
bump in one shot; the stages are also individually invocable.

---

## WOF source gazetteer — `admin-global-priority.db`

The canonical local build that `candidate.db` is derived from. Listed here because it is the
artifact the FST priors and every offline eval read, and because a Hugging Face dataset card for it
exists in the repository.

**Contents.** Tables `spr` (one row per place), `names` (multi-language variants), `concordances`
(cross-source ids), `place_population`, and `ancestors`, plus a `place_search` FTS5 index and a
`place_bbox` R\*Tree built separately. It is deliberately **not** the off-the-shelf geocode.earth WOF
dump — those assign different WOF ids to the same place, which would break every id we have ever
published.

**Tier:** internal. It is not part of the npm release and is not currently published anywhere; the
published derivative is `candidate.db` above.

:::note[The Hugging Face dataset card is stale]

[`hf-publish/mailwoman-wof-gazetteer/README.md`](https://github.com/sister-software/mailwoman/blob/main/hf-publish/mailwoman-wof-gazetteer/README.md)
describes a **1.09 GB, seven-country** build with 1,288,749 places and seven FST binaries. It was
last touched on 2026-05-28, at package version 0.5.4, and every number in it is a snapshot of that
date. The current build is global (244 countries) and only four FST locales are still produced.
Treat the card as history, not as a description of anything you can download today.

:::

---

## POI layer — `poi.db`

Layer #1 on the [spatial-layer contract](../plan/reference/layer-contract.mdx), and the worked
example every later layer copies. It answers category and brand queries — "coffee near Springfield
IL" — rather than address queries.

**Contents.** 13,681,698 Overture Places rows at confidence ≥ 0.85 (US 11.52M, CA 794k, FR 721k,
MX 644k), clustered on `(h3_cell, category_id, neg_rank, rowid_key)` as a `WITHOUT ROWID` B-tree so
a neighborhood query is one contiguous range read. H3 cells are res 9, matching
`ADDRESS_H3_RESOLUTION` in `@mailwoman/address-id`, so a POI-to-address join is key equality rather
than cell math. Plus an FTS5 name index, a brand table, and 159,702 res-6 coverage cells.

**Upstream source.** Overture Maps Foundation, Places theme, release 2026-05-20.0.
**License:** CDLA-Permissive-2.0. **Attribution:** "Overture Maps Foundation" — recorded in the
layer manifest, so the obligation travels with the file.

**Tier:** `shipped`, written into the manifest by the builder. Published to R2 at
`https://public.sister.software/mailwoman/poi/<version>/poi.db`.

**Version / cadence.** Currently `2026-07-20a`. `freshness_policy = sealed`, meaning updates are
full rebuilds rather than in-place refreshes. Rebuild cadence follows Overture's release cadence in
principle; no schedule is committed.

**Approximate size.** 3.7 GB sealed.

**Build.** `mailwoman gazetteer build poi --countries US,CA,MX,FR`. The
[POI layer runbook](../plan/reference/poi-layer-runbook.mdx) is the full build/verify/publish
procedure, including the Overture schema traps that bite first-time builders.

:::info[The ODbL half of POI is a different artifact]

Infrastructure categories — fiber huts, telephone exchanges, street cabinets — have no permissive
source. They live in OpenStreetMap and in Overture's `base` theme, both ODbL, and Overture does not
launder OSM's license. So there is a **second**, `build-local` POI layer built from OSM, and this
shipped `poi.db` is not it. Queries that need infrastructure abstain with
`requires_build_local_layer` rather than guessing. We ship that builder; we do not ship its output.

:::

---

## US situs shards — `address-points-us-<st>.db`

The precision tier for the United States: an exact building coordinate, not a street estimate and
not a city centroid.

**Contents.** One `address_point` table per state, carrying normalized and raw street, house
number, unit, postcode, normalized locality, coordinate, and — the part that matters for licensing
— a per-row `source` string and source release. 124.9 million points across 50 per-state shards.

**Upstream sources.** Overture's Addresses theme, which for the US is the National Address Database
(68%, US public domain) plus OpenAddresses (32%, government open data). A 2026-06-14 measurement
recorded **zero** OpenStreetMap/ODbL rows in the US set, which is why the build applies no license
filter by default. Per-row provenance is stamped `overture:<dataset>` or `openaddresses`.

**Obligation.** Attribution. NAD is public domain and asks nothing; the named OpenAddresses sources
want credit. `mailwoman situs attribution-manifest` regenerates an `ATTRIBUTION.json` from the
shards on disk, which is the document you hand downstream.

**Tier:** shipped. Hosted byte-range on R2 at
`https://public.sister.software/mailwoman/street/us/<slug>/situs.db` for 52 slugs — all 50 states
plus DC and the US Virgin Islands.

**Version / cadence.** Release `2026-05-20.0`, pinned per artifact family through a `releases.json`
manifest at the data root. No fixed rebuild schedule.

**Approximate size.** Per-state, and it varies enormously with population. The one figure this
repository records is DC at 119,889,920 bytes (~114 MB) — and a demo lookup against it reads about
280 KB of that file, which is the entire argument for byte-range serving.

**Coverage gaps worth knowing.** Hawaii is built from OpenAddresses (348K rooftop points) because
the primary source does not cover it. New Hampshire has **no** rooftop source at all and resolves
at street level through interpolation only.

**Build.** `mailwoman situs address-points --state VT` for one state; `mailwoman situs build` for
the national fan-out.

---

## US interpolation shards — `interpolation-us-<st>.db`

The fallback under the situs tier: where no rooftop point exists, estimate the coordinate from the
street segment's house-number range. An exact situs point always wins; interpolation never
overrides one.

**Contents.** A `street_segment` table with one row **per side** of each address-carrying road edge
— left and right carry independent number ranges and ZIPs in the source — with parity, county FIPS,
and the segment geometry as GeoJSON text. Built across all 3,143 counties of the contiguous US.

**Upstream source.** US Census TIGER/Line 2023 EDGES shapefiles. **License:** public domain.
**Obligation:** none.

**Tier:** shipped. Hosted at
`https://public.sister.software/mailwoman/street/us/<slug>/interp.db`.

**Version / cadence.** Release `TIGER2023`. TIGER publishes annually; the shards are rebuilt when
we take a new vintage.

**Approximate size.** Not recorded per state in this repository.

**Build.** `mailwoman situs interpolation-shard --state VT`, or `mailwoman situs interpolation` for
the national download-and-build driver.

**Related.** The `@mailwoman/tiger` workspace also builds `tiger.db` — tabulation blocks, places,
street features, and the 2020 P.L. 94-171 redistricting table — which is a corpus and demographics
input rather than a resolver artifact. Build-local, public domain,
`mailwoman tiger fetch --state <FIPS>`.

---

## FR situs shard — `address-points-fr.db`

France's national address register, on the same situs schema as the US shards, so the resolver
reads it with no code change.

**Contents.** 26 million address points across 101 départements. A companion
`street-centroids-fr.db` rolls the same register up to 2.2M street-level rows with centroid,
bounding box, and member-point count, for street-only queries.

**Upstream source.** Base Adresse Nationale, from `adresse.data.gouv.fr`, release 2026-05-18.

**License.** **Licence Ouverte / Open Licence 2.0 (Etalab)** — attribution only, **no share-alike**.
BAN is dual-licensed and we elect the permissive option, which is why the shard ships under the same
terms as the permissive core and needed no counsel gate.

**Attribution.** "© les contributeurs de la Base Adresse Nationale (adresse.data.gouv.fr)", carried
per-row as `source = ban:fr` and recorded in `ban/ATTRIBUTION.json` alongside source URL, release,
row count, and md5 at build time.

**Tier:** shipped. Hosted at
`https://public.sister.software/mailwoman/street/fr/<version>/situs.db`, currently `2026-07-10`
(the quote-fix and arrondissement-fold rebuild).

**Approximate size.** 6.9 GB sealed.

**Build.** `node ban/out/scripts/build-address-point-shard.js --csv-dir <dir> --release 2026-05-18`.
A `--depts` flag builds a transient sample for validation first.

**Not included.** No interpolation shard exists for France. The exact-point tier covers the win;
house numbers BAN does not carry are simply not interpolated.

---

## OSM rooftop shards — `address-points-<cc>-<slug>.db`

Rooftop coverage for countries with no permissive national register. Complete, benchmarked, and
**not distributed by us**.

**Contents.** The same situs schema again, built address-point-first: the exact `addr:housenumber`
coordinate from a node, or a building polygon's centroid. Interpolation is deliberately excluded —
we read only OSM's explicit `addr:interpolation` ways and never synthesize a house-number line from
scattered points. Street locales exist for FR, DE, and NL.

Measured shards, from the 2026-06-29 build session:

| Shard                              | Points       | Size         | Street-association gap |
| ---------------------------------- | ------------ | ------------ | ---------------------- |
| DE / Berlin                        | 450,900      | 108 MB       | 0.3%                   |
| NL / national                      | 9,919,996    | 2.3 GB       | 0.0%                   |
| FR (with nearest-highway recovery) | 477k → 1.13M | not recorded | 58% → 1.3%             |

**Upstream source.** Geofabrik PBF extracts of OpenStreetMap. **License:** ODbL — attribution
**and** share-alike on a Derivative Database.

**Tier:** build-local, and specifically **publish-blocked**. No OSM shard ships to npm, R2, or the
public demo until counsel has reviewed how ODbL share-alike applies to this distribution model. The
`@mailwoman/osm` workspace is **code only** — it contains no OSM data, so depending on it carries no
obligation. Building and benchmarking locally is fine today; publishing is not.

The three open questions, and the four structural mechanisms that keep ODbL data out of the
permissive core, are on [data licensing & provenance](./data-provenance.md#the-odbl-boundary).

**Build.** `node osm/out/scripts/build-rooftop-shard.js --country fr --slug idf --release <tag>
--pbf <file>`. Needs GDAL's `ogr2ogr` on PATH.

---

## Timezone lookup — `timezone.db`

**Contents.** A single `timezone_polygons` table: one row per boundary feature with its IANA tzid,
a bounding box for the prefilter, and MultiPolygon coordinates as JSON. Point-in-polygon runs over
`node:sqlite`, server-side only.

**Upstream source.** [timezone-boundary-builder](https://github.com/evansiroky/timezone-boundary-builder),
from its `combined-with-oceans.json` release artifact. No upstream release is pinned in the
repository.

**License.** **ODbL.** Attribution and share-alike apply to the database you build and distribute.

**Tier:** build-local. `@mailwoman/timezone-lookup` is published to npm at 8.3.0 and ships the
builder and the reader; it ships no `.db`.

**Approximate size / row count.** Not recorded. The build prints a feature count at runtime and
nothing writes it down.

**Build.**
`npx @mailwoman/timezone-lookup build --geojson combined-with-oceans.json --out timezone.db`.
Walkthrough: [looking up a timezone](../recipes/timezones.md).

---

## UN/LOCODE lookup — `un-locode.db`

**Contents.** A single `un_locode` table, one row per assigned location: country, location code,
name, normalized name, and coordinates where the source carries them. Supports exact lookup by name
and nearest-code lookup by coordinate.

**Upstream source.** The UNECE UN/LOCODE code list (`code-list.csv`). No URL or release is recorded
in the repository.

**License.** The repository describes it as a **public domain** code list with no share-alike
obligation. No formal identifier (CC0 or otherwise) is given.

**Tier:** build-local. `@mailwoman/un-locode-lookup` is published to npm at 8.3.0; the `.db` is not.

**Row counts.** 116k entries, of which roughly 93k carry coordinates. (An older docstring in the
package puts the coordinate-bearing share at about a third; the README and recipe figures above are
the ones to use.)

**Build.** `npx @mailwoman/un-locode-lookup build --csv code-list.csv --out un-locode.db`.
Walkthrough: [UN/LOCODE lookup](../recipes/un-locode-lookup.md).

---

## NUTS lookup — `nuts.db`

**Contents.** A single `nuts_regions` table: one row per region with its NUTS id, level, bounding
box, and geometry. Levels 1–3, queried outward from the finest, which is the shape OpenCage returns.

**Upstream source.** [Eurostat GISCO](https://ec.europa.eu/eurostat/web/gisco) NUTS boundaries,
from a `NUTS_RG_*_4326.geojson` export. No vintage is pinned.

**License.** **Not determined.** The repository records only an attribution string — "© EuroGeographics
for the administrative boundaries" — and no license identifier anywhere. Until the actual terms are
established, treat redistribution of a built `nuts.db` as an open question.

**Tier:** build-local. `@mailwoman/nuts-lookup` is published to npm at 8.3.0.

**Approximate size / row count.** Not recorded.

**Build.** `npx @mailwoman/nuts-lookup build --geojson NUTS_RG_03M_2021_4326.geojson --out nuts.db`.

---

## Neural weights bundles

The parser itself, distributed as data-only npm packages that `@mailwoman/neural` loads at runtime.
Unlike everything else on this page these ship on npm rather than R2, and unlike everything else on
this page they are a **first-party artifact** — we trained them, so their license is ours to set.

**License.** `AGPL-3.0-only OR LicenseRef-Commercial` — the same dual license as the engine. The
Hugging Face-facing READMEs list only the AGPL half; the `package.json` and model card carry the
dual form and are authoritative.

| Package                               | Role                    | npm   | Unpacked |
| ------------------------------------- | ----------------------- | ----- | -------- |
| `@mailwoman/neural-weights-en-us`     | the self-contained base | 8.3.0 | ~72 MB   |
| `@mailwoman/neural-weights-en-gb`     | data-only overlay       | 8.3.0 | ~12 MB   |
| `@mailwoman/neural-weights-fr-fr`     | data-only overlay       | 8.3.0 | ~17 MB   |
| `@mailwoman/neural-weights-en-nz`     | data-only overlay       | 8.3.0 | ~8 MB    |
| `@mailwoman/neural-weights-base-latn` | parked, not published   | 7.8.1 | —        |

**Contents.** The en-US package carries the model (`model.onnx`), the SentencePiece tokenizer, the
model card, calibration tables, the US postcode FST, the en-US and street-morphology FST gazetteer
priors, and four evidence lexicons. The overlays share the base's byte-identical model and tokenizer
and ship only their locale-specific siblings — a postcode FST, a locale FST, and where the locale
has one, a `pair-index-<cc>.bin` placetype-pair index (GB: 19,209 pairs, ~458 KB; NZ: 3,134 pairs,
~55 KB).

**Model.** Version 7.0.0, the from-scratch base. ONNX int8 dynamic quantized from fp32, opset 17,
max sequence 128, six layers at hidden size 384, vocabulary 73,143, roughly 29M parameters.
**37.6 MB int8** (146.6 MB fp32). Note that the en-US package README prints older size and
vocabulary figures; the `model-card.json` is the functional contract.

**Training data.** Compiled from permissive sources only, by construction: the corpus build filters
share-alike rows through `SHARE_ALIKE_PATTERN` (`--exclude-share-alike`), and the model card's
attribution list names HM Land Registry PPD (OGL v3.0), LINZ-derived OpenAddresses NZ (CC-BY 4.0),
BAN (Licence Ouverte 2.0), Overture Addresses (CDLA-Permissive-2.0), and several per-country
OpenAddresses sets. **No ODbL source appears.** The attribution obligations from the CC-BY and OGL
sources are real and ride with the model card.

**Tier:** shipped, on two backends that must agree — npm for the packages, and the public Hugging
Face bucket `sister-software/mailwoman` for the binaries the CI publish job pulls in.

**Cadence.** No cadence is committed. Versioning is lockstep: every workspace shares one version per
release, weights included, so a weights package version tracks the release number and not the
model's own lineage. Most releases are code-only; promoting a newly trained model to be the default
is a deliberate, larger operation. The model's own identity lives in `model_lineage` on the card.

**Note on card drift.** The overlay model cards are not auto-bumped at release, so their `version`
fields lag the base. Read `model_lineage` and `files_md5`, not the overlay card's version number.

---

## Broadband filings — `bdc.db` (planned)

**Status: designed, not built.** Phase 2a of the broadband-plausibility vertical. Listed so the
shape is public; nothing exists to download.

**Intended contents.** FCC Broadband Data Collection availability filings at census-block grain:
provider id, technology code, advertised up/down speeds, latency flag, business/residential code,
the 15-character block GEOID, and the Fabric BSL `location_id` carried as an **opaque join key
only**. Spine keys `wof_id` and res-9 `h3` from the block centroid; deliberately **not**
`address_id`, because a block-grained filing is not an address-grained fact and any per-address
answer is an inference across the block, flagged as such.

**Upstream source.** FCC BDC availability data — US government public record, public domain.

**Intended tier.** Shipped candidate. The open cost is size rather than licensing: a nationwide
fixed-broadband vintage is on the order of 10⁸ rows, so the likely resolution is a shipped
pilot-state pocket with build-local for the rest, mirroring the POI layer's pilot-then-scale
posture.

**Intended cadence.** `versioned-refresh` — re-issued under the same name per BDC vintage, each
issue itself sealed, with the `as_of_date` carried as `source_vintage` and surfaced on every answer.
A filing landscape is only ever "as of vintage X".

**The boundary that will not move.** The CostQuest Fabric — the licensed map from BSL id to a
precise rooftop point — is **never ingested, never shipped, and never derived from**. All spatial
work happens at public block granularity plus the address spine we already own.

---

## What is not on this shelf

- **Build inputs.** Postcode shards, `tiger.db`, the durable GeoNames alias fold, and the raw
  Overture parquet slices are intermediates that feed the artifacts above. They are documented
  in the build runbooks, not here.
- **Demo assets.** The map-highlight polygons and the address-coverage tile overlay exist to make
  the demo work; see the [coverage overlay runbook](../plan/reference/coverage-overlay.mdx).
- **Your data.** A `private`-tier layer conforming to the same contract — a CRM export, survey
  notes, parcel relationships — joins the same query surface and never leaves your machine. That
  is a supported posture, not a product we sell.

## See also

- [Data licensing & provenance](./data-provenance.md) — the per-source license table, the ODbL
  boundary, and what counsel still needs to confirm.
- [Pricing](./pricing.mdx) — the engine's tiers, and the
  [OEM band](./pricing.mdx#embedding-mailwoman-in-a-product-you-sell) for shipping Mailwoman inside
  a product you license to others.
- [Spatial-layer contract](../plan/reference/layer-contract.mdx) — the schema every layer database
  embeds, and where the tier vocabulary on this page comes from.
- [POI layer runbook](../plan/reference/poi-layer-runbook.mdx) — the worked build/verify/publish
  example.
- [Data, locales, and coverage](../concepts/data-locales-and-coverage.mdx) — the same layers
  described by what they can and cannot resolve.
- [Address data sources](../plan/reference/address-data-sources.mdx) — the upstream register
  catalog and the licensing gradient.
- [Software Bill of Materials](./sbom.md) — the code-side inventory, per release.
