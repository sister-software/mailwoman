# Counsel dossier — every open legal question, one document

**Purpose:** the project has no counsel on retainer; this dossier is the operator's best-effort
collection of every standing legal question (operator, 2026-07-30: "do your best and I'll forward
it over when the project actually pays for one"). Each item carries the question, the facts we
verified ourselves, and what we're doing in the meantime. Items are ordered by how much shipped
product they gate. This file is the single source — new legal questions land HERE, not in
scattered plan docs.

## 1. ODbL — the osm/ workspace publish-block + OSM-derived corpus quarantine

**The question:** does publishing `@mailwoman/osm` (fetch/shard tooling for OSM rooftop points)
and/or shipping OSM-derived training corpora make our artifacts (npm packages, trained weights,
built databases) ODbL derivative databases subject to share-alike?

**Facts:** the osm/ workspace is complete but publish-blocked (its README records the posture);
OSM-derived corpus shards are quarantined into their own license bucket at build time
(`.notes/data-sources.md` build sheet); poi.db ships ODbL-attributed as a **build-local** artifact
on the layer contract's tiers.

**Interim posture:** publish-block holds; quarantine discipline holds; poi.db stays build-local.
The KR framework (item 4) reuses this exact posture.

## 2. BDC / broadband vertical (the spec's eight questions, verbatim source: §8 of

`docs/superpowers/specs/2026-07-20-bdc-plausibility-design.md`)

1. **CostQuest Fabric boundary** — is carrying the BSL `location_id` as an opaque join key (no
   coordinate, no derived table) clear of the Fabric license? Gates phase 2a.
2. bdc.db distribution tier (shipped-continental vs build-local) — product call with a license rider.
3. Pilot-state choice — product call, no legal rider.
4. BDC vintage cadence — product call.
5. **HIFLD power.db** — public-domain or access-restricted? Gates the grid layer.
6. **OSM telecom infra** — same ODbL sign-off as item 1; confirm the posture transfers.
7. **Market-size denominator** — confirm TIGER `housing_unit_count` is an acceptable public proxy
   (the Fabric per-block count being licensed).
8. Provider registry (CORES/Form-499) freshness/curation — operational, minor license check.

## 3. Hong Kong ALS

**The question:** data.gov.hk's terms grant download/distribute/reproduce commercially but are
**silent on adaptation, derivative works, and sublicensing** (`license_id: null` on the ALS bulk
GeoJSON). Compiling ALS into an FST/gazetteer artifact is adaptation — permitted or not?

**Facts:** verified by the 2026-07-30 prior-art survey (full landscape in
`docs/superpowers/plans/2026-07-30-tokenizer-cjk-prior-art-synthesis.md`).

**Interim posture:** same as osm/ — no HK artifact ships until answered.

## 4. Korea

**The questions:**

1. Do the **KOGL** grants on the specific `localdata.go.kr` datasets we'd ingest cover commercial
   use + derivatives (KOGL Type 1), and does anything in the 도로명주소법 framework reach
   business-permit address data (we believe it does not — the export pledge attaches to the juso
   register downloads)?
2. The **juso plug-and-play layer** (decided framework, 2026-07-30): we ship a builder; the
   CUSTOMER downloads juso under their own grant and builds in-country; the layer manifest carries
   the obligations as notice. Sanity-check the notice language + confirm this shape keeps us
   outside the pledge entirely.
3. If a KR rooftop engagement ever wants OUR involvement: do weights trained in-country on juso
   data constitute "export" of the data? (Not needed for the current framework; a future-partner
   question.)

**Facts:** the juso bulk DB ToS bars commercial use/redistribution without approval; the
coordinate datasets carry a signed export pledge (국외 반출 금지); data.go.kr's portal metadata
("no restriction") does not override the statute. All verified in the prior-art survey.

**Interim posture:** we never touch juso data; the KR parse recipe uses only KOGL/WOF/OSM-quarantined
sources; the juso builder is written against the DOCUMENTED format + synthetic fixtures only.

## 5. Japan (all green; two riders)

**Facts:** ABR = PDL-1.0 (CC BY 4.0-compatible; requires attribution + a modification notice);
MLIT = PDL-1.0; Geolonia = CC BY 4.0; KEN_ALL = copyright expressly disclaimed by Japan Post.

**Riders:** (a) parcel-level ABR 地番マスター carries a second Ministry-of-Justice grant — check
before any parcel-tier JP feature; (b) **MJ文字情報一覧表 / MJ縮退マップ are CC BY-SA 2.1 JP
(share-alike)** — if we ever ship a DERIVED itaiji-normalization table, the share-alike reaches
the table file; sourcing the equivalences from GREEN data instead avoids it.

## 6. Taiwan (green with mechanics)

OGDL-Taiwan-1.0 on the municipal 門牌 data: attribution failure voids the license **ab initio**,
and agencies may withdraw data (§5.2). Mechanics, not questions: ship the ~21-entry per-agency
attribution manifest in the package and pin/archive the snapshots. Chunghwa Post 3+3 postcodes
are RED (no distribution/adaptation grant) — we do not ship them; flag if a TW postcode feature
is ever wanted.

## 7. Commercial-license text (GTM A2)

The pricing page (PR #1353) publishes two durable commitments before any legal review:
rate-fixed-at-signup and OEM no-revenue-share/no-exclusivity. The A2 license text itself
(amendments to COMMERCIAL-LICENSE.md) is drafted-not-reviewed. Both CTAs are mailto-only, so
nothing closes self-serve — but the text should be first in line when counsel exists.

## 8. G-NAF mail-compilation clause (standing, low)

The AU G-NAF EULA bars compiling mailing lists without deliverability verification. Fine for
parser training; becomes live only if a customer uses output for mailing-list generation —
a terms-of-use rider on OUR license docs, not a blocker.
