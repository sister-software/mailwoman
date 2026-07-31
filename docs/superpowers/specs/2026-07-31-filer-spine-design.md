# The filer spine — identity crosswalk, corporate families, physical nexus (Phase 3) — design

2026-07-31. Operator + Claude. **Draft for operator review.** Extends the BDC vertical
(`2026-07-20-bdc-plausibility-design.md`): 2a shipped filings, 2b ships physical corroboration,
and this spec answers the question both of those leave open — _who is the filer, actually, and what
do they physically hold?_ Absorbs the 2c provider registry (see §7).

## 1. The problem

US telecom identity is deliberately fragmented across a dozen public registries that do not join
cleanly. A single operating company can appear as: an FRN in CORES, a 499 Filer ID with a separately
named holding company, a SPIN at USAC, a six-digit provider ID in BDC, an OCN in NECA/LERG, an ASN
at ARIN, a CIK at the SEC, a state CPCN per state, and a dozen DBAs in marketing. Nothing publishes
the crosswalk. The opacity is load-bearing for the incumbents: a census block showing "five
providers" may be two corporate families, and the map calls that competition.

Mailwoman is unusually well placed to fix this because the hard part is **record linkage over messy
org names and addresses**, which is exactly `@mailwoman/{record,match,registry}`, and because the
answer has to attach to **physical geography**, which is the h3/layer spine.

**Product statement:** point at a structure (tower, fiber hut, exchange, data center) or an area and
get back who holds what there, which filings claim it, which corporate families those filings roll up
to, and what the public record physically supports.

## 2. Doctrine (binding — same posture as §4 of the BDC spec)

1. **Documented relationships only.** A corporate-family edge is emitted only when a public document
   asserts it (Form 499 holding-company field, SEC Exhibit 21 subsidiary list, CORES related-FRN,
   an ASR owner record). Inferred edges are labeled inferred, with the matcher's score and the
   evidence that produced them. Never a bare claim.
2. **Disclosure, never accusation.** The product says "these five filers report the same holding
   company" or "no license or registered structure corroborates this claim in this county." It never
   says a filer is deceptive, fraudulent, or lying. Intent is not in the record and not ours to
   assert. This is both the honest posture and the legal one.
3. **Absence is not impossibility.** Unlicensed operation is lawful and common — CBRS GAA, 5/6 GHz
   unlicensed backhaul, leased fiber, wholesale/resale, and roaming all produce real service with no
   license, no structure, and no facility in the operator's own name. "No corroborating nexus found"
   is the strongest negative the spine may emit, and only with coverage confidence attached.
4. **Provenance per edge.** Every crosswalk edge carries source, source vintage, and assertion type.
   A crosswalk without provenance is a rumor with a schema.

## 3. Identifier inventory

| Identifier                  | Registry                           | Public?                     | Join value                                                                                 | Notes                                                                                                                      |
| --------------------------- | ---------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **FRN**                     | FCC CORES                          | Yes, bulk                   | **The hub.** Nearly every other FCC identity hangs off it                                  | 10-digit; entity + address + contact                                                                                       |
| **499 Filer ID**            | FCC/USAC Form 499 filer database   | Yes, published file         | **Highest-value single file**: carries FRN, legal name, _holding company_, contacts        | The trench-coat decoder for carriers                                                                                       |
| **SPIN (498 ID)**           | USAC                               | Yes                         | USF disbursements ↔ entity                                                                 | Ties subsidy money to filer                                                                                                |
| **BDC provider_id**         | FCC BDC                            | Yes                         | Already in `bdc.db.provider_id`; `bdc_provider` sidecar exists unpopulated (2a task 7)     | The landing seam is already built                                                                                          |
| **ASR number**              | FCC Antenna Structure Registration | Yes, bulk + **coordinates** | **The crown jewel for physical nexus**: structure lat/lon + owner FRN                      | Registered structures only (height/lighting thresholds)                                                                    |
| **ULS license**             | FCC Universal Licensing System     | Yes, weekly bulk            | Spectrum authority by FRN + geography; Part 101 microwave paths are strong backhaul signal | Enormous; scope by service code                                                                                            |
| **ASN / org**               | ARIN, PeeringDB                    | Yes, API                    | Routing reality; PeeringDB `fac` gives facility presence                                   | This is C6's substrate — same spine                                                                                        |
| **CIK**                     | SEC EDGAR                          | Yes, API                    | Public-company identity; **Exhibit 21 = literal subsidiary list**                          | Only covers public parents                                                                                                 |
| **OCN**                     | NECA                               | Partially                   | ILEC/CLEC identity, LERG                                                                   | Licensing on bulk LERG is restrictive — verify                                                                             |
| **EIN**                     | IRS                                | **Mostly NOT public**       | —                                                                                          | Public only via SEC cover pages and **nonprofit 990s** (which do cover many rural co-op ISPs). Do not promise EIN coverage |
| **State CPCN / SOS entity** | 50 state registries                | Heterogeneous               | Registered agent + officer names often reveal family                                       | Per-state scrapers; OpenCorporates licensing is restrictive — verify before use                                            |

### 3.1 Form 499 — the column vocabulary (read from Nexus, 2026-07-31)

`isp-nexus/universe/sync/fcc/universal-service.ts` already encodes the real 499 TSV column set, which
is worth more than the code around it:

`form499ID · frn · lastFiledAt · usfContributor · legalNameOfCarrier · doingBusinessAs ·
principalCommType · holdingCompany · managementCompany · hqAddress · customerInquiriesTelephone ·
customerInquiriesAddress · dcAgentDisplayName · dcAgentOrganizationName · dcAgentTelephone ·
dcAgentEmailAddress · dcAgentAddress`

Three findings that change the design:

1. **There are TWO family fields, not one** — `holdingCompany` _and_ `managementCompany`. They differ
   in kind (ownership vs operational control) and both deserve typed edges rather than being collapsed.
2. **`principalCommType` is a free classification signal** — the Nexus code maps it to
   Incumbent LEC / CLEC / Interexchange / Toll Reseller. Port the mapping; it tells you what _kind_ of
   carrier a filer is without any inference.
3. **The DC agent is an anti-pattern for family inference.** The 499 "DC agent" is the agent for
   service of process, and that role is dominated by a handful of firms (CT Corporation, CSC, Cogency
   Global) serving tens of thousands of unrelated companies. Shared registered agent must **never**
   produce a family edge — it is the single most likely false-positive generator in this whole design.
   Record it as an attribute; never as evidence of relatedness.

**Salvage verdict: take the vocabulary and the classification mapping; rewrite the loader.** The Nexus
implementation reads the entire TSV into memory, silently truncates short rows
(`relax_column_count_less`), declares `otherTradeName1` in its interface while omitting it from the
column tuple (so it is never populated — a live bug), and carries a `findFilingByID` docstring
promising recursive replacement-filing resolution with cycle handling over an implementation that is a
plain `Map.get`. The column tuple and the `principalCommType` mapping are the durable parts.

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
  comparators. This is the existing Fellegi-Sunter path, not a new subsystem.

**Edges are time-scoped — this is load-bearing, not bookkeeping.** Ownership changes faster than
filing vintages update (worked example: a filer acquired ~7 months before the BDC vintage under
inspection still files under its pre-acquisition identity — see
`2026-07-31-evidence-axes-beyond-filings.md` §2.1). Every family rollup query therefore takes a date,
every answer states the vintage it was computed against, and a rollup joined to a filing from a
different vintage reports the skew rather than silently reconciling it. An untimed family graph
answers today's ownership against last year's filing and is wrong invisibly.

Connected components over authoritative-only edges = **entity clusters** (one operating company).
Adding family edges (holding company, parent CIK) collapses clusters into **corporate families**.
Two rollups, always distinguishable, never merged silently.

### 4.2 The artifact

New workspace **`@mailwoman/filer`** (mirrors `ban`/`osm`/`bdc`: `filer/sdk` acquisition + schema +
readers) producing **`filer.db`**, a layer-contract sealed artifact (`versioned-refresh`, public
domain), spine-keyed on h3 res-9 for anything with coordinates (ASR structures) plus the identifier
tables. Row grain: one row per identifier node, one per edge, one per family membership.

### 4.3 Physical nexus

The query the operator actually wants — _point at a structure, get the picture_ — composes:

1. Structure → owner: ASR (authoritative, coordinates in the record) or 2b's OSM infra layer
   (build-local, no ownership) or PeeringDB `fac` (facility ↔ networks present).
2. Owner FRN → entity cluster → corporate family (§4.1).
3. Area around the structure → `filingLandscape` (2a) → claiming provider_ids → their families.
4. Spectrum authority in that geography → ULS licenses held by those families (Part 101 paths,
   Part 27/90 area licenses).
5. Output: an evidence bundle in the 2b shape — claims, corroboration, coverage confidence — plus
   the family rollup and an explicit `unlicensed_operation_possible: true` note wherever the claimed
   technology can lawfully run without any of the above (doctrine §2.3).

### 4.4 The competition view

`competition(area)` returns filer count **and** family count, side by side, with the collapse
explained edge by edge ("filers A, B, C report holding company H per 499 vintage X"). The honest
headline is a ratio, not a verdict: _this block shows five filers and two families._ Where a family
edge is inferred rather than documented, it is reported separately and never folded into the primary
count.

## 5. Why this is also the best available eval for `@mailwoman/match`

The 499 filer database contains, in one row, both the authoritative FRN↔holding-company link **and**
the messy legal/DBA name strings. That makes a **gold set for free**: hold out the authoritative
field, run the fuzzy matcher over names + addresses, and measure precision/recall against ground
truth at real scale (thousands of filers, genuine corporate-name pathology — shells, numerals,
"Inc" vs "Incorporated", d/b/a chains). This is a publishable record-linkage eval on public data,
which is a positioning artifact in its own right (Track E) and stresses `match`/`record` harder than
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
  layer-contract table on the h3 spine; **ULS Part 101 only** (decision D2); the
  point-at-a-structure query; joins to 2b's infra layer and `bdc.db`.
- **3d — analytical surface + private CRM (~3).** `competition(area)` with the family collapse; the
  private CRM layer and `reconcile` buckets inherited from 2c; plausibility discounted by nexus
  (feeds C7 market-entry intelligence); MCP tools.

## 7. Relationship to 2c — RESOLVED: folded

**2c is dissolved into Phase 3** (operator, 2026-07-31). Its registry and matcher wiring become 3a;
its private-CRM reconciliation becomes 3d. The BDC vertical consumes the spine rather than carrying
its own provider registry, so the registry is built once. Track C's C3 row now points here.

## 8. Decisions (ratified 2026-07-31)

- **D1 — Fold 2c into 3a.** Operator. See §7.
- **D2 — ULS: Part 101 only.** Operator. Part 101 point-to-point microwave is the right scope for a
  further reason worth recording: a Part 101 license describes a _path_ — both endpoint coordinates
  plus the licensee FRN — so it is physical backhaul evidence, not merely an area authority. A fixed
  wireless operator with licensed backhaul leaves a two-ended geometric trace. Doctrine §2.3 still
  binds: unlicensed backhaul is lawful, so a missing path is never disproof. Part 27/90 area licenses
  and CBRS/SAS are deferred; revisit only if 3d's competition view demonstrably needs them.
- **D3 — Naming: `@mailwoman/filer` → `filer.db`.** Controller call. Domain-accurate ("filer" is the
  FCC's own term) and `registry` is taken by the record-matching app.
- **D4 — Federal-only for v1; no state registries.** Controller call. Fifty heterogeneous scrapers
  buy the long tail of small privately-held operators — precisely where the corporate-family question
  is least interesting (a single-county WISP is not a national carrier in a trench coat). The federal
  pair (499 holding company + EDGAR Exhibit 21) covers the entities the analysis is actually about.
  OpenCorporates is excluded by the same call, which moots its licensing question for v1.
- **D5 — Publication posture: split the two artifacts.** Controller call. The **record-linkage eval**
  (§5) is publishable early and safely — it is a methods result about matching, naming no company's
  conduct. The **filers-vs-families competition analysis** ships as an internal/product capability
  first and becomes public only as a separate, deliberate operator decision after real output has
  been reviewed. Different wording bar, different risk; do not bundle them.
- **D6 — EIN dropped from the spine.** Controller call. Mostly non-public; CIK + FRN already carry
  the joining load. Retained opportunistically as an attribute where a source hands it over (SEC
  cover pages, 990s); no dedicated ingest. A 990 pass can be reconsidered if rural co-ops become a
  focus, since that is where it would actually pay.
- **D7 — v1 sources are licensing-clean.** CORES, Form 499, ASR, ULS, and EDGAR are all US federal
  public domain, so **Phase 3 is not gated on counsel** — unlike the Fabric question hanging over 2a.
  PeeringDB (API terms) is a 3c/C6-time check; LERG/OCN and OpenCorporates are out of scope by D4.
  Recorded in the counsel dossier as informational, not blocking.

## 9. Open questions (deferred, not blocking)

1. Does 3d's competition view need Part 27/90 area licenses after all? (Revisit at 3d exit — D2.)
2. Is a 990-based EIN/co-op pass worth its own slice once rural operators are a named segment? (D6.)
3. When the competition analysis is good enough to publish, who reviews the wording? (D5 — the
   answer today is the operator; revisit if counsel is ever retained.)

## 10. Carried into 3b from 3a (2026-07-31)

- **Inferred linkage is degenerate in 3a and must be rebuilt on real corroboration.** 3a's identifier veto (added after an adversarial review found it merging "American Broadband LLC" with "American Broadband, Inc." across disjoint FRNs) is correct but structurally reduces pass (b) to "same authoritative component": identifier sets are derived per component, so sharing an identifier implies sharing a component by construction. Genuine discovery — two filings that _are_ one company but share no identifier — needs evidence beyond the canonical name. 3b has it: CORES parent/subsidiary fields, EDGAR Exhibit 21, plus normalized HQ address and contact phone/email from the 499 columns already parsed. Design the corroboration rule there; do not restore name-only linkage.
- **Same-vintage supersession** for inferred edges (3a fix round 2) is the pattern transfer-of-control edges must follow when they land.

## 11. CORES access — corrected diagnosis (2026-07-31)

**Correction to the 3a Task-9 record.** That task reported `data.fcc.gov` as "403 at the Akamai edge."
That was wrong, and the distinction matters for 3b.

`https://data.fcc.gov/api/frn/getInfo?frn=…` returns **HTTP 302 → `www.fcc.gov/what-can-we-help-you-find`**
— the FCC's generic retired-URL landing page. The endpoint appears **decommissioned**, not blocked. The
403 originally observed was the _redirect target_ (`www.fcc.gov`) refusing this host, so a dead endpoint
was misread as a network block. Documentation pages for retired APIs linger, which is why the search
evidence looked encouraging.

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
   programmatic source, and the family-edge story for 3b rests on Form 499's `holdingCompany` /
   `managementCompany` plus SEC EDGAR Exhibit 21 — both already available.
2. **ULS is fully de-risked for 3c.** `data.fcc.gov/download/pub/uls/complete/` is reachable and current
   (weekly archives dated 2026-07-25). Part 101 microwave — the backhaul evidence D2 scoped us to —
   is in that tree.
3. **ASR needs a new location.** `data.fcc.gov/download/pub/asr/` now 302s to the same retired-URL page,
   and `pub/` contains only `uls/`. ASR is 3c's crown jewel (structures with coordinates _and_ owner
   FRN), so finding its current bulk path is a 3c prerequisite — and the FCC's ASR pages live on
   `www.fcc.gov`/`wireless2.fcc.gov`, both blocked here.
