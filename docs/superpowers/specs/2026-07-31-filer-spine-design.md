# The filer spine — identity crosswalk, corporate families, physical nexus (Phase 3) — design

2026-07-31. Operator + Claude. **Draft for operator review.** This spec extends the BDC vertical
(`2026-07-20-bdc-plausibility-design.md`). 2a shipped filings and 2b ships physical corroboration.
This spec answers the question both leave open: _who is the filer really, and what
do they physically hold?_ It absorbs the 2c provider registry (see §7).

## 1. The problem

US telecom identity is deliberately split across a dozen public registries that do not join
directly. A single operating company can appear as an FRN in CORES, a 499 Filer ID with a separately
named holding company, a SPIN at USAC, a six-digit provider ID in BDC, an OCN in NECA/LERG, an ASN
at ARIN, a CIK at the SEC, a CPCN in each state, and a dozen DBAs in marketing. Nobody publishes
the crosswalk. The incumbents benefit from this opacity: a census block that shows "five
providers" may hold only two corporate families, and the map presents that as competition.

Mailwoman is well placed to fix this for two reasons. The hard part is **record linkage over messy
org names and addresses**, which is what `@mailwoman/{record,match,registry}` does. The
answer also has to attach to **physical geography**, which the h3/layer spine provides.

**Product statement:** point at a structure (tower, fiber hut, exchange, data center) or an area and
get back who holds what there, which filings claim it, which corporate families those filings roll up
to, and what the public record physically supports.

## 2. Doctrine (binding — same posture as §4 of the BDC spec)

1. **Documented relationships only.** A corporate-family edge is emitted only when a public document
   asserts it (Form 499 holding-company field, SEC Exhibit 21 subsidiary list, CORES related-FRN,
   an ASR owner record). Inferred edges are labeled as inferred and carry the matcher's score and the
   evidence that produced them. No edge is a bare claim.
2. **Disclosure, never accusation.** The product says "these five filers report the same holding
   company" or "no license or registered structure corroborates this claim in this county." It never
   says a filer is deceptive, fraudulent, or lying. The record does not show intent, and it is not ours to
   assert. This position is both the direct one and the legally safe one.
3. **Absence is not impossibility.** Unlicensed operation is lawful and common. CBRS GAA, 5/6 GHz
   unlicensed backhaul, leased fiber, wholesale/resale, and roaming all deliver real service without a
   license, a structure, or a facility in the operator's own name. "No corroborating nexus found"
   is the strongest negative the spine may emit, and only with coverage confidence attached.
4. **Provenance per edge.** Every crosswalk edge carries its source, source vintage, and assertion type.
   An edge without provenance cannot be checked, so the spine does not store one.

## 3. Identifier inventory

| Identifier                  | Registry                           | Public?                     | Join value                                                                                 | Notes                                                                                                                         |
| --------------------------- | ---------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| **FRN**                     | FCC CORES                          | Yes, bulk                   | **The hub.** Nearly every other FCC identity hangs off it                                  | 10-digit; entity + address + contact                                                                                          |
| **499 Filer ID**            | FCC/USAC Form 499 filer database   | Yes, published file         | **Highest-value single file**: carries FRN, legal name, _holding company_, contacts        | Reveals the holding company behind carriers                                                                                   |
| **SPIN (498 ID)**           | USAC                               | Yes                         | USF disbursements ↔ entity                                                                 | Ties subsidy money to filer                                                                                                   |
| **BDC provider_id**         | FCC BDC                            | Yes                         | Already in `bdc.db.provider_id`; `bdc_provider` sidecar exists unpopulated (2a task 7)     | The landing table is already built                                                                                            |
| **ASR number**              | FCC Antenna Structure Registration | Yes, bulk + **coordinates** | **The most valuable physical-nexus source**: structure lat/lon + owner FRN                 | Registered structures only (height/lighting thresholds)                                                                       |
| **ULS license**             | FCC Universal Licensing System     | Yes, weekly bulk            | Spectrum authority by FRN + geography; Part 101 microwave paths are strong backhaul signal | Enormous; scope by service code                                                                                               |
| **ASN / org**               | ARIN, PeeringDB                    | Yes, API                    | Routing reality; PeeringDB `fac` gives facility presence                                   | This is C6's substrate — same spine                                                                                           |
| **CIK**                     | SEC EDGAR                          | Yes, API                    | Public-company identity; **Exhibit 21 = literal subsidiary list**                          | Only covers public parents                                                                                                    |
| **OCN**                     | NECA                               | Partially                   | ILEC/CLEC identity, LERG                                                                   | Licensing on bulk LERG is restrictive — verify                                                                                |
| **EIN**                     | IRS                                | **Mostly not public**       | —                                                                                          | Public only via SEC cover pages and **nonprofit 990s** (which do cover several rural co-op ISPs). Do not promise EIN coverage |
| **State CPCN / SOS entity** | 50 state registries                | Heterogeneous               | Registered agent + officer names frequently reveal family                                  | Per-state scrapers; OpenCorporates licensing is restrictive — verify before use                                               |

### 3.1 Form 499 — the column vocabulary (read from Nexus, 2026-07-31)

`isp-nexus/universe/sync/fcc/universal-service.ts` already encodes the real 499 TSV column set. The
column set is worth more than the code around it:

`form499ID · frn · lastFiledAt · usfContributor · legalNameOfCarrier · doingBusinessAs ·
principalCommType · holdingCompany · managementCompany · hqAddress · customerInquiriesTelephone ·
customerInquiriesAddress · dcAgentDisplayName · dcAgentOrganizationName · dcAgentTelephone ·
dcAgentEmailAddress · dcAgentAddress`

Three findings change the design:

1. **There are two family fields: `holdingCompany` _and_ `managementCompany`.** They differ
   in kind (ownership vs operational control), and each deserves its own typed edge instead of being collapsed into one.
2. **`principalCommType` is a free classification signal.** The Nexus code maps it to
   Incumbent LEC / CLEC / Interexchange / Toll Reseller. Port the mapping, because it tells you what _kind_ of
   carrier a filer is without any inference.
3. **The DC agent must not be used for family inference.** The 499 "DC agent" is the agent for
   service of process. A handful of firms (CT Corporation, CSC, Cogency
   Global) fill that role for tens of thousands of unrelated companies. A shared registered agent must **never**
   produce a family edge, and it is the most likely source of false positives in this whole design.
   Record it as an attribute and never as evidence of relatedness.

**Salvage verdict: take the vocabulary and the classification mapping, and rewrite the loader.** The Nexus
implementation reads the entire TSV into memory and silently truncates short rows
(`relax_column_count_less`). It declares `otherTradeName1` in its interface but omits it from the
column tuple, so the field is never populated, which is a live bug. Its `findFilingByID` docstring
promises recursive replacement-filing resolution with cycle handling, but the implementation is a
plain `Map.get`. The column tuple and the `principalCommType` mapping are the parts worth keeping.

## 4. Architecture

### 4.1 The crosswalk as a provenanced graph

Nodes are `(identifier_type, identifier_value)`. Edges are assertions:

```
edge: { from, to, assertion: "authoritative" | "inferred", source, source_vintage,
        valid_from, valid_to?, match_score?, evidence? }
```

- **Authoritative** edges come from a document that states both identifiers in one row (499 row
  carrying FRN + Filer ID + holding company; ASR record carrying ASR + owner FRN; EDGAR Exhibit 21
  carrying parent CIK + subsidiary name).
- **Inferred** edges come from `@mailwoman/match` over normalized org name + registered address +
  contact, with FRN/SPIN/ASN as `exactDiscriminator`s when present and name/address as scored
  comparators. This reuses the existing Fellegi-Sunter path and adds no new subsystem.

**Edges are time-scoped, and the dates are required data.** Ownership changes faster than
filing vintages update. In the worked example, a filer acquired ~7 months before the BDC vintage under
inspection still files under its pre-acquisition identity (see
`2026-07-31-evidence-axes-beyond-filings.md` §2.1). Every family rollup query therefore takes a date,
and every answer states the vintage it was computed against. A rollup joined to a filing from a
different vintage reports the skew instead of silently reconciling it. A family graph without dates
reports today's ownership against last year's filing, and nobody can see the error.

Connected components over authoritative-only edges form **entity clusters**, each one operating company.
Adding family edges (holding company, parent CIK) merges clusters into **corporate families**.
The two rollups always stay distinguishable and are never merged silently.

### 4.2 The artifact

A new workspace, **`@mailwoman/filer`**, follows the `ban`/`osm`/`bdc` layout (`filer/sdk` acquisition + schema +
readers). It produces **`filer.db`**, a sealed layer-interface artifact (`versioned-refresh`, public
domain). Anything with coordinates (ASR structures) is keyed on the h3 res-9 spine, alongside the identifier
tables. Row grain: one row per identifier node, one per edge, and one per family membership.

### 4.3 Physical nexus

The operator's main query, _point at a structure and get the full picture_, combines these steps:

1. Structure → owner: from ASR (authoritative, with coordinates in the record), from 2b's OSM infra layer
   (build-local, without ownership data), or from PeeringDB `fac` (facility ↔ networks present).
2. Owner FRN → entity cluster → corporate family (§4.1).
3. Area around the structure → `filingLandscape` (2a) → claiming provider_ids → their families.
4. Spectrum authority in that geography → ULS licenses held by those families (Part 101 paths,
   Part 27/90 area licenses).
5. Output: an evidence bundle in the 2b shape (claims, corroboration, coverage confidence), plus
   the family rollup and an explicit `unlicensed_operation_possible: true` note wherever the claimed
   technology can lawfully run without any of the above (doctrine §2.3).

### 4.4 The competition view

`competition(area)` returns the filer count **and** the family count side by side and explains the
reduction edge by edge ("filers A, B, C report holding company H per 499 vintage X"). The
headline is a ratio and not a verdict: _this block shows five filers and two families._ When a family
edge is inferred and not documented, it is reported separately and never folded into the primary
count.

## 5. Why this is also the best available eval for `@mailwoman/match`

Each row of the 499 filer database contains both the authoritative FRN↔holding-company link **and**
the messy legal/DBA name strings. That yields a **gold set at no cost**: hold out the authoritative
field, run the fuzzy matcher over names + addresses, and measure precision/recall against ground
truth at real scale. The data covers thousands of filers and real corporate-name problems, such as shells, numerals,
"Inc" vs "Incorporated", and d/b/a chains. The result would be a publishable record-linkage eval on public data.
It would help position the project on its own (Track E), and it tests `match`/`record` harder than
any synthetic corpus.

## 6. Phasing (agent-night sizing, each phase gets its own plan)

- **3a — identity core (~4, absorbs 2c's registry + matcher wiring).** `@mailwoman/filer` workspace;
  CORES + 499 acquisition (Nexus salvage: `sync/scripts/registrations.ts` already joins BDC provider
  CSV × 499 by FRN — see the salvage survey); crosswalk schema with provenance; authoritative edges
  only; entity clustering via `@mailwoman/match`; `bdc_provider` sidecar finally populated;
  `filer_lookup` MCP tool.
- **3b — corporate families + the matcher eval (~3).** Holding-company edges from 499; SEC EDGAR CIK
  - Exhibit 21 ingestion for public parents; family rollup; the held-out record-linkage eval of §5
    published as a scorecard.
- **3c — physical nexus (~4).** ASR bulk ingest (structures + coordinates + owner FRN) as a
  layer-interface table on the h3 spine; **ULS Part 101 only** (decision D2); the
  point-at-a-structure query; joins to 2b's infra layer and `bdc.db`.
- **3d — analytical surface + private CRM (~3).** `competition(area)` with the family collapse; the
  private CRM layer and `reconcile` buckets inherited from 2c; plausibility discounted by nexus
  (feeds C7 market-entry intelligence); MCP tools.

## 7. Relationship to 2c — RESOLVED: folded

**2c is folded into Phase 3** (operator, 2026-07-31). Its registry and matcher wiring become 3a,
and its private-CRM reconciliation becomes 3d. The BDC vertical uses the spine instead of carrying
its own provider registry, so the registry is built once. Track C's C3 row now points here.

## 8. Decisions (ratified 2026-07-31)

- **D1 — Fold 2c into 3a.** Operator. See §7.
- **D2 — ULS: Part 101 only.** Operator. There is a further reason Part 101 point-to-point microwave is the right scope:
  a Part 101 license describes a _path_, with both endpoint coordinates
  plus the licensee FRN. It is therefore physical backhaul evidence and more than an area authority. A fixed
  wireless operator with licensed backhaul leaves a trace with two geographic endpoints. Doctrine §2.3 still
  applies: unlicensed backhaul is lawful, so a missing path never disproves a claim. Part 27/90 area licenses
  and CBRS/SAS are deferred. Revisit them only if 3d's competition view demonstrably needs them.
- **D3 — Naming: `@mailwoman/filer` → `filer.db`.** Controller call. The name is accurate to the domain ("filer" is the
  FCC's own term), and the record-matching app already uses `registry`.
- **D4 — Federal-only for v1, without state registries.** Controller call. Fifty heterogeneous scrapers would
  cover the long tail of small privately-held operators, which is exactly where the corporate-family question
  matters least, because a single-county WISP is not a national carrier operating under another name. The federal
  pair (499 holding company + EDGAR Exhibit 21) covers the entities the analysis is about.
  The same call excludes OpenCorporates, so its licensing question does not arise for v1.
- **D5 — Publication posture: split the two artifacts.** Controller call. The **record-linkage eval**
  (§5) can be published early and safely. It is a methods result about matching and names no company's
  conduct. The **filers-vs-families competition analysis** ships first as an internal/product capability
  and becomes public only through a separate, deliberate operator decision after real output has
  been reviewed. The two have different wording standards and different risks, so do not bundle them.
- **D6 — EIN dropped from the spine.** Controller call. EINs are mostly non-public, and CIK + FRN already
  do the joining. The spine keeps an EIN as an attribute when a source provides one (SEC
  cover pages, 990s), with no dedicated ingest. A 990 pass can be reconsidered if rural co-ops become a
  focus, because that is where it would pay off.
- **D7 — v1 sources are licensing-clean.** CORES, Form 499, ASR, ULS, and EDGAR are all US federal
  public domain, so **Phase 3 does not wait on counsel**, unlike the Fabric question that still blocks 2a.
  PeeringDB (API terms) is checked at 3c/C6 time, and D4 puts LERG/OCN and OpenCorporates out of scope.
  The counsel dossier records this as informational and not blocking.

## 9. Open questions (deferred rather than blocking)

1. Does 3d's competition view need Part 27/90 area licenses after all? (Revisit at 3d exit — D2.)
2. Is a 990-based EIN/co-op pass worth its own increment once rural operators are a named segment? (D6.)
3. When the competition analysis is good enough to publish, who reviews the wording? (D5 — the
   answer today is the operator; revisit if counsel is ever retained.)

## 10. Carried into 3b from 3a (2026-07-31)

- **Inferred linkage is degenerate in 3a and must be rebuilt on real corroboration.** 3a's identifier veto (added after an adversarial review found it merging "American Broadband LLC" with "American Broadband, Inc." across disjoint FRNs) is correct but structurally reduces pass (b) to "same authoritative component": identifier sets are derived per component, so sharing an identifier implies sharing a component by construction. Discovering two filings that _are_ one company but share no identifier needs evidence beyond the canonical name. 3b has that evidence: CORES parent/subsidiary fields, EDGAR Exhibit 21, plus normalized HQ address and contact phone/email from the 499 columns already parsed. Design the corroboration rule there; do not restore name-only linkage.
- **Same-vintage supersession** for inferred edges (3a fix round 2) is the pattern transfer-of-control edges must follow when they land.

## 11. CORES access — corrected diagnosis (2026-07-31)

**Correction to the 3a Task-9 record.** That task reported `data.fcc.gov` as "403 at the Akamai edge."
The report was wrong, and the distinction matters for 3b.

`https://data.fcc.gov/api/frn/getInfo?frn=…` returns **HTTP 302 → `www.fcc.gov/what-can-we-help-you-find`**,
the FCC's generic landing page for retired URLs. The endpoint appears to be **decommissioned** rather than blocked. The
403 originally observed came from the _redirect target_ (`www.fcc.gov`) refusing this host, so a dead endpoint
was misread as a network block. Documentation pages for retired APIs stay online, which is why the search
results looked encouraging.

**Host reachability from the lab machine** (verified):

| Host                   | Status              | Notes                                                                     |
| ---------------------- | ------------------- | ------------------------------------------------------------------------- |
| `data.fcc.gov`         | **200**             | Entire bulk-download tree reachable                                       |
| `apps.fcc.gov`         | **200**             | CORES public site loads                                                   |
| `broadbandmap.fcc.gov` | 401 unauthenticated | Works with credentials — BDC ingest is unaffected                         |
| `www.fcc.gov`          | **403**             | Akamai edge; identifying User-Agent does not help, so it is host/IP-based |
| `wireless2.fcc.gov`    | **403**             | Same                                                                      |

**Consequences:**

1. **3b's CORES plan needs a new premise.** The FRN Conversions API cannot be assumed to exist. Before
   any CORES work, confirm from a machine that can reach `www.fcc.gov` whether the documented API is
   retired and whether a successor exists. If none does, CORES parent/subsidiary data has no supported
   programmatic source. 3b's family edges would then come from Form 499's `holdingCompany` /
   `managementCompany` plus SEC EDGAR Exhibit 21, and both are already available.
2. **ULS carries no access risk for 3c.** `data.fcc.gov/download/pub/uls/complete/` is reachable and current
   (weekly archives dated 2026-07-25). The Part 101 microwave data, which is the backhaul evidence D2 scoped us to,
   is in that tree.
3. **ASR needs a new location.** `data.fcc.gov/download/pub/asr/` now returns a 302 to the same retired-URL page,
   and `pub/` contains only `uls/`. ASR is 3c's most valuable source (structures with coordinates _and_ owner
   FRN), so finding its current bulk path is a 3c prerequisite. The FCC's ASR pages are on
   `www.fcc.gov`/`wireless2.fcc.gov`, and both are blocked here.

## 12. ASR and ULS sources — resolved and verified (2026-07-31)

Operator research resolved §11's open questions, and the reachable parts were then verified directly from
the lab host.

**FRN Conversions API: confirmed dead.** It was dismantled with the Reboot-FCC-era portal and never
migrated, and modern FCC developer documentation no longer references it. Today the Commission expects users
to go from FRN to entity through ULS, CORES/registration search, and License View. **Consequence for 3b:** no
supported programmatic CORES wrapper exists, so family edges come from Form 499's
`holdingCompany`/`managementCompany` (already parsed in 3a) plus SEC EDGAR Exhibit 21. Plan 3b on those
two sources and treat any CORES access as a bonus rather than a dependency.

**ASR bulk: found, reachable, and current.** It lives inside the ULS transaction downloads rather than in a
separate ASR tree. It is verified present at `data.fcc.gov/download/pub/uls/complete/`, a host that answers
from here:

| File          | Size    | Contents                                           |
| ------------- | ------- | -------------------------------------------------- |
| `r_tower.zip` | ~33 MB  | Complete **registration** database — the 3c source |
| `a_tower.zip` | ~161 MB | Complete application database                      |
| `d_tower.zip` | ~56 MB  | FAA determination database                         |

Daily deltas follow `r_tow_<day>.zip` / `a_tow_<day>.zip` / `d_tow_<day>.zip`. The observed archives were dated
2026-07-28. The `pub/uls/complete/` tree also carries the Part 101 license data D2 scoped us to, so
**both of 3c's data dependencies are in one reachable directory.**

**Do not adopt the ArcGIS FeatureServer.** It was suggested as an
easier alternative to the fixed-width archives. It is easier to use, but we verified two problems that make it unsuitable:

1. **It covers one state instead of the whole country.** `asr_asr_OR` returns **351 features**, while the national register
   holds well over a hundred thousand structures. The sample shows Oregon-area geometry.
2. **It has no FRN field.** All 29 fields are: `OBJECTID, RegNum, UniqSysID, Entity, ContAdd, ContPO,
ContCity, ContState, ContZip, ContName, LatDeg…LonDir, CoordsType, StatusCode, LocAdd, LocCity,
LocState, Strucht, FAAstudy, FAAcirc, latdec, londec, url`. Owner appears only as `Entity`, a name
   string. **Joining a structure to a filer by name rather than FRN produces exactly the false identity links
   that 3a's identifier veto exists to prevent** ("American Broadband LLC" vs "American Broadband,
   Inc."). The FRN is the whole reason ASR matters to this project, so the convenient source is the
   wrong one.

**3c decision, pre-registered here:** ingest `r_tower.zip` (fixed-width) and key structures on the
registrant **FRN** rather than on `Entity`. During 3c recon, confirm that the fixed-width layout carries the FRN.
If it does not, ASR cannot join to the crosswalk authoritatively, and the phase must be rethought
before any code is written.
