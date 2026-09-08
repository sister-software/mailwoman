# Counsel dossier — every open legal question, one document

**Purpose:** the project has no counsel on retainer; this dossier is the operator's best-effort
collection of every standing legal question (operator, 2026-07-30: "do your best and I'll forward
it over when the project actually pays for one"). Each item carries the question, the facts we
verified ourselves, and what we're doing in the meantime. Items are ordered by how much shipped
product they check. This file is the single source — new legal questions land HERE, not in
scattered plan docs.

## 1. ODbL — the osm/ workspace publish-block + OSM-derived corpus quarantine

**The question:** does publishing `@mailwoman/osm` (fetch/extract tooling for OSM rooftop points)
and/or shipping OSM-derived training corpora make our artifacts (npm packages, trained weights,
built databases) ODbL derivative databases subject to share-alike?

**Facts:** the osm/ workspace is complete but publish-blocked (its README records the posture);
OSM-derived corpus extracts are quarantined into their own license bucket at build time
(`.notes/data-sources.md` build sheet); poi.db ships ODbL-attributed as a **build-local** artifact
on the layer contract's tiers.

**Interim posture:** publish-block holds; quarantine discipline holds; poi.db stays build-local.
The KR framework (item 4) reuses this exact posture.

## 2. BDC / broadband vertical (the spec's eight questions, verbatim source: §8 of

`docs/superpowers/specs/2026-07-20-bdc-plausibility-design.md`)

1. **CostQuest Fabric boundary** — is carrying the BSL `location_id` as an opaque join key (no
   coordinate, no derived table) clear of the Fabric license? Checks phase 2a.
2. bdc.db distribution tier (shipped-continental vs build-local) — product call with a license rider.
3. Pilot-state choice — product call, no legal rider.
4. BDC vintage cadence — product call.
5. **HIFLD power.db** — public-domain or access-restricted? Checks the grid layer.
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

**Facts (chain of custody, read 2026-09-07):**

- What shipped: `@mailwoman/neural-weights-cjk` 0.0.2 (the `v8-cjk-kr` weights, trained on 2,000,000
  rows of the KR corpus `v8-kr-2026-09-06`) and the 249-pair 시군구 register in `@mailwoman/codex/kr`.
  No coordinates ship. The board's coordinates are read locally.
- Where the corpus came from: OpenAddresses' `asia.zip` (collected 2021-10-20), whose `LICENSE.txt`
  lists every `kr/<province>/provincewide` as `License: Unknown`, `Required attribution: Ministry of
the Interior`. The source definition (`sources/kr/11/provincewide.json`) points at a contributor
  upload, `korea-feb2017.zip`, and its `license` field carries only an attribution name. The pull
  request that added it (openaddresses/openaddresses#2688, merged 2017-03-26) says "I did not see a
  clear license". The file inside is the building-entrance point file (`entrc_<region>.txt`).
- What that product is at the source: the ministry's 도로명주소 위치정보 요약DB (entrance coordinates) and
  도로명주소 전자지도. On data.go.kr both carry 공공누리 제1유형 (attribution; commercial use and
  derivatives permitted) AND the note that they are provided only after a separate application and a
  purpose-of-use review by the local government or the ministry (시행령 제46조, 시행규칙 제53조,
  별지 제32호서식). Nobody in the chain above applied. The application form's wording is unread.
- The export rule: 도로명주소법 제25조 제10항 forbids taking a 주소정보기본도 or 주소정보안내도 that contains
  disclosure-restricted spatial information out of Korea without the minister's permission (up to two
  years or 20,000,000 won). Whether entrance coordinates count as restricted is unread.
- The unrestricted products: the 도로명주소 한글 주소DB (시도, 시군구, 읍면동, 도로명, 건물본번·부번, 우편번호,
  the 지번 file beside it; no coordinates) and the 영문 주소DB are direct downloads labelled
  "이용허락범위 제한 없음" on data.go.kr, no application. Every field the weights learned from, and every
  name in the register, is in those products.
- KOGL's AI type (2026-01-28, 문화체육관광부 + 과학기술정보통신부): permits training and commercial use of
  the trained model, forbids resale of the training set and outputs substantially similar to the source,
  and applies only where the agency adds the AI mark. None of the address datasets carry it.

**Posture:** the 2026-09-06 decisions (the KR spec, `docs/superpowers/specs/2026-09-06-kr-under-the-cjk-package.md`)
replaced the earlier "never touch juso data" line. The exposure is confined to the coordinate file in the
2017 upload. The next CJK training run rebuilds the KR corpus from the unrestricted 주소DB (road-name and
지번 registers, front-door download, provenance recorded in the build report), so the shipped weights
rest on a product with no application step. Until that run promotes, the 0.0.2 weights stay as shipped
with the attribution line in the card.

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

## 9. Lite artifact line (GTM D1 — the six L-markers)

Verbatim source: `docs/superpowers/specs/2026-07-30-lite-artifact-line-design.md`, which defines
the free/subscriber data-channel split (delayed public cadence, keyed registration, attribution
on the free channel) and marks every point where an instrument would be needed.

1. **L1 — registration-form data collection.** The Lite key form collects name, email, company,
   so it is a personal-data collection. Notice text at point of collection, retention period for
   the download log, and whether the privacy page's "architecturally does not collect" framing
   needs a written carve-out. Checks the form going up.
2. **L2 — the instrument the Lite key is issued under.** Not the AGPL (that governs our code, not
   a compiled database) and not the commercial license. Needs a short data-use notice carrying the
   attribution condition and sitting correctly on top of the upstream licenses.
3. **L3 — can we condition a compiled artifact whose inputs are public domain?** The working
   assumption is that the attribution condition rides the download agreement, not a copyright
   claim over facts; EU database-compilation right vs US contract likely differ. **This is the
   required question for the whole Lite line.**
4. **L4 — the WOF license, and it is fact-finding first.** The repo contradicts itself: the
   licensing pages say CC0, `resolver-wof-sqlite/README.md` and the HF dataset card say CC-BY 4.0,
   `THIRD_PARTY_NOTICES.md` says "several sources with their own licenses." If CC-BY, the
   gazetteer carries a standing attribution obligation in **both** channels. The upstream's own
   license page may answer the question without a lawyer.
5. **L5 — Eurostat GISCO NUTS terms** (the EuroGeographics component). The repo records an
   attribution string and no license identifier at all, so whether a built `nuts.db` may be
   redistributed is unknown. Fact-finding first.
6. **L6 — co-location does not contaminate.** Confirm there is no argument that building a
   permissively-sourced artifact in the same pipeline, data root, or publish path as ODbL
   artifacts creates a derivative-database relationship. The architecture already assumes not
   (item 1's quarantine mechanisms); this asks counsel to confirm rather than discover.

**Interim posture:** nothing ships on the Lite line. The prerequisites that need no lawyer (L4
and L5 fact-finding, the share-alike build filter for the US situs extracts, and putting the
artifact builds on a schedule) proceed independently.
