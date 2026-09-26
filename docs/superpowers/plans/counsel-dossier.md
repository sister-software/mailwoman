# Counsel dossier — every open legal question, one document

**Purpose:** the project has no counsel on retainer. This dossier is the operator's best-effort
collection of every standing legal question (operator, 2026-07-30: "do your best and I'll forward
it over when the project pays for one"). Each item states the question, the facts we
verified ourselves, and what we do in the meantime. Items are ordered by how much shipped
product each one affects. New legal questions go in this file rather than in
separate plan docs.

## 1. ODbL — the osm/ workspace publish-block + OSM-derived corpus quarantine

**The question:** does publishing `@mailwoman/osm` (fetch/extract tooling for OSM rooftop points),
shipping OSM-derived training corpora, or both make our artifacts (npm packages, trained weights,
built databases) ODbL derivative databases subject to share-alike?

**Facts:** the osm/ workspace is complete but blocked from publishing, and its README records why.
At build time, OSM-derived corpus extracts go into their own license bucket
(`.notes/data-sources.md` build sheet). poi.db ships with ODbL attribution as a **build-local** artifact
in the layer interface's tiers.

**Interim posture:** the osm/ workspace stays unpublished, OSM-derived extracts stay in their own bucket, and poi.db stays build-local.
The KR framework (item 4) uses the same approach.

## 2. BDC / broadband vertical (the spec's eight questions, verbatim source: §8 of

`docs/superpowers/specs/2026-07-20-bdc-plausibility-design.md`)

1. **CostQuest Fabric boundary**: is carrying the BSL `location_id` as an opaque join key, without the
   coordinate or any derived table, clear of the Fabric license? Phase 2a waits on the answer.
2. bdc.db distribution tier (shipped-continental vs build-local) is a product call with a license rider.
3. The pilot-state choice is a product call without a legal rider.
4. BDC vintage cadence is a product call.
5. **HIFLD power.db**: is it public-domain or access-restricted? The grid layer waits on the answer.
6. **OSM telecom infra** needs the same ODbL sign-off as item 1. Confirm that the item 1 approach applies here too.
7. **Market-size denominator**: confirm that TIGER `housing_unit_count` is an acceptable public proxy,
   since the Fabric per-block count is licensed.
8. Provider registry (CORES/Form-499) freshness and curation is an operational matter with a minor license check.

## 3. Hong Kong ALS

**The question:** data.gov.hk's terms grant commercial download, distribution, and reproduction but
**make no statement about adaptation, derivative works, or sublicensing** (`license_id: null` on the ALS bulk
GeoJSON). Compiling ALS into an FST/gazetteer artifact is adaptation. Is that permitted?

**Facts:** the 2026-07-30 prior-art survey verified these terms. The full survey is in
`docs/superpowers/plans/2026-07-30-tokenizer-cjk-prior-art-synthesis.md`.

**Interim posture:** as with osm/, no HK artifact ships until counsel answers.

## 4. Korea

**The questions:**

1. Do the **KOGL** grants on the specific `localdata.go.kr` datasets we'd ingest cover commercial
   use and derivatives (KOGL Type 1)? Does anything in the 도로명주소법 framework reach
   business-permit address data? We believe it does not, because the export pledge attaches to the juso
   register downloads.
2. The **juso plug-and-play layer** (framework decided 2026-07-30): we ship a builder, the
   customer downloads juso under their own grant and builds in-country, and the layer manifest states
   the obligations as a notice. Check the notice language and confirm that this arrangement keeps us
   entirely outside the pledge.
3. If a KR rooftop engagement ever needs our own involvement, do weights trained in-country on juso
   data count as an "export" of the data? The current framework does not need an answer. This is a future-partner
   question.

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
  derivatives permitted) and the note that they are provided only after a separate application and a
  purpose-of-use review by the local government or the ministry (시행령 제46조, 시행규칙 제53조,
  별지 제32호서식). Nobody in the chain above applied. The application form's wording is unread.
- The export rule: 도로명주소법 제25조 제10항 forbids taking a 주소정보기본도 or 주소정보안내도 that contains
  disclosure-restricted spatial information out of Korea without the minister's permission (up to two
  years or 20,000,000 won). Whether entrance coordinates count as restricted is unread.
- The unrestricted products: the 도로명주소 한글 주소DB (시도, 시군구, 읍면동, 도로명, 건물본번·부번, 우편번호,
  and the 지번 file beside it, without coordinates) and the 영문 주소DB are direct downloads labeled
  "이용허락범위 제한 없음" on data.go.kr and need no application. Every field the weights learned from, and every
  name in the register, is in those products.
- KOGL's AI type (2026-01-28, 문화체육관광부 + 과학기술정보통신부): permits training and commercial use of
  the trained model, forbids resale of the training set and outputs substantially similar to the source,
  and applies only where the agency adds the AI mark. None of the address datasets carry it.

**Posture:** the 2026-09-06 decisions (the KR spec, `docs/superpowers/specs/2026-09-06-kr-under-the-cjk-package.md`)
replaced the earlier rule against touching juso data. The exposure is limited to the coordinate file in the
2017 upload. The next CJK training run rebuilds the KR corpus from the unrestricted 주소DB (the road-name and
지번 registers, downloaded directly, with provenance recorded in the build report). The shipped weights will then
rest on a product that has no application step. Until that run is promoted, the 0.0.2 weights stay as shipped,
with the attribution line in the card.

## 5. Japan (all green; two riders)

**Facts:** ABR is PDL-1.0, which is CC BY 4.0-compatible and requires attribution and a modification notice.
MLIT is PDL-1.0. Geolonia is CC BY 4.0. Japan Post expressly disclaims copyright on KEN_ALL.

**Riders:** (a) The parcel-level ABR 地番マスター carries a second Ministry-of-Justice grant. Check
it before building any parcel-tier JP feature. (b) **MJ文字情報一覧表 / MJ縮退マップ are CC BY-SA 2.1 JP
(share-alike).** If we ever ship an itaiji-normalization table derived from them, the share-alike terms apply to
the table file. Sourcing the equivalences from green-licensed data avoids that.

## 6. Taiwan (green with mechanics)

OGDL-Taiwan-1.0 covers the municipal 門牌 data. A failure to attribute voids the license **ab initio**,
and agencies may withdraw data (§5.2). Both points call for procedures rather than legal answers: ship the ~21-entry per-agency
attribution manifest in the package, and pin and archive the snapshots. Chunghwa Post 3+3 postcodes
are red because their terms grant no distribution or adaptation rights. We do not ship them. Raise the issue if a TW postcode feature
is ever wanted.

## 7. Commercial-license text (GTM A2)

The pricing page (PR #1353) published two lasting commitments before any legal review:
the rate is fixed at signup, and OEM deals carry no revenue share and no exclusivity. The A2 license text itself
(amendments to COMMERCIAL-LICENSE.md) is drafted but not reviewed. Both CTAs are mailto links, so
no sale closes self-serve. The text should still be the first item counsel reviews.

## 8. G-NAF mail-compilation clause (standing, low)

The AU G-NAF EULA bars compiling mailing lists without deliverability verification. Parser training
is unaffected. The clause matters only if a customer uses our output to generate mailing lists.
It calls for a terms-of-use rider on our license docs and does not block anything.

## 9. Lite artifact line (GTM D1 — the six L-markers)

Verbatim source: `docs/superpowers/specs/2026-07-30-lite-artifact-line-design.md`, which defines
the free/subscriber data-channel split (delayed public cadence, keyed registration, attribution
on the free channel) and marks every point where an instrument would be needed.

1. **L1 — registration-form data collection.** The Lite key form collects name, email, and company,
   so it collects personal data. Counsel should settle the notice text at the point of collection, the retention period for
   the download log, and whether the privacy page's "architecturally does not collect" wording
   needs a written carve-out. The form cannot go live until these are settled.
2. **L2 — the instrument the Lite key is issued under.** It cannot be the AGPL, which governs our code and not
   a compiled database, and it cannot be the commercial license. The key needs a short data-use notice that states the
   attribution condition and fits correctly on top of the upstream licenses.
3. **L3 — can we attach conditions to a compiled artifact whose inputs are public domain?** The working
   assumption is that the attribution condition comes from the download agreement rather than from a copyright
   claim over facts. The EU database-compilation right and US law likely differ here. **The whole Lite line
   depends on this answer.**
4. **L4 — the WOF license, which needs fact-finding first.** The repo contradicts itself: the
   licensing pages say CC0, `resolver-wof-sqlite/README.md` and the HF dataset card say CC-BY 4.0,
   `THIRD_PARTY_NOTICES.md` says "several sources with their own licenses." If CC-BY, the
   gazetteer carries a standing attribution obligation in **both** channels. The upstream's own
   license page may answer the question without a lawyer.
5. **L5 — Eurostat GISCO NUTS terms** (the EuroGeographics component). The repo records an
   attribution string and no license identifier at all, so whether a built `nuts.db` may be
   redistributed is unknown. This also needs fact-finding first.
6. **L6 — co-location with ODbL artifacts.** Confirm that building a
   permissively-sourced artifact in the same pipeline, data root, or publish path as ODbL
   artifacts does not create a derivative-database relationship. The architecture already assumes it does not
   (item 1's quarantine mechanisms), so this item asks counsel to confirm an existing assumption.

**Interim posture:** no artifact ships on the Lite line. The prerequisites that need no lawyer (L4
and L5 fact-finding, the share-alike build filter for the US situs extracts, and putting the
artifact builds on a schedule) proceed independently.
