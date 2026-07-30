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

## 4. Architecture

### 4.1 The crosswalk as a provenanced graph

Nodes are `(identifier_type, identifier_value)`. Edges are assertions:

```
edge: { from, to, assertion: "authoritative" | "inferred", source, source_vintage, match_score?, evidence? }
```

- **Authoritative** edges come from a document that states both identifiers in one row (499 row
  carrying FRN + Filer ID + holding company; ASR record carrying ASR + owner FRN; EDGAR Exhibit 21
  carrying parent CIK + subsidiary name).
- **Inferred** edges come from `@mailwoman/match` over normalized org name + registered address +
  contact, with FRN/SPIN/ASN as `exactDiscriminator`s when present and name/address as scored
  comparators. This is the existing Fellegi-Sunter path, not a new subsystem.

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

- **3a — identity core (~3-4).** `@mailwoman/filer` workspace; CORES + 499 acquisition (Nexus
  salvage: `sync/scripts/registrations.ts` already joins BDC provider CSV × 499 by FRN — see the
  salvage survey); crosswalk schema with provenance; authoritative edges only; entity clustering via
  `@mailwoman/match`; `bdc_provider` sidecar finally populated; `filer_lookup` MCP tool.
- **3b — corporate families (~2-3).** Holding-company edges from 499; SEC EDGAR CIK + Exhibit 21
  ingestion for public parents; family rollup; the matcher eval of §5 published as a scorecard.
- **3c — physical nexus (~3-4).** ASR bulk ingest (structures + coordinates + owner FRN) as a
  layer-contract table on the h3 spine; ULS scoped to the service codes that matter; the
  point-at-a-structure query; joins to 2b's infra layer and `bdc.db`.
- **3d — the analytical surface (~2-3).** `competition(area)` with the family collapse; plausibility
  discounted by nexus (feeds C7 market-entry intelligence); MCP tools; the "filers vs families"
  public write-up if the operator wants the positioning.

## 7. Relationship to 2c

2c as specced (provider registry keyed by FRN, matcher-joined, private CRM reconcile) is a strict
subset of 3a. **Recommendation: fold 2c into 3a** rather than build the registry twice — 2c's CRM
reconciliation becomes a 3a deliverable, and the BDC vertical consumes the spine instead of carrying
its own registry. Operator decision; the alternative is a narrow 2c now and a migration later.

## 8. Open questions (operator)

1. **Fold 2c into 3a, or keep both?** (§7 — recommendation: fold.)
2. **ULS scope.** Full weekly bulk is very large. Which services first — Part 101 microwave (backhaul
   nexus), Part 27/90 (area licenses), or defer ULS entirely to 3c-late?
3. **Naming.** `@mailwoman/filer` / `filer.db`? (`registry` is taken by the record-matching app.)
4. **State registries.** Worth the per-state scraper cost, or stay federal-only for v1? OpenCorporates
   licensing needs checking before any use.
5. **Publication posture.** Is "filers vs families" a public artifact (positioning, Track E) or an
   internal capability that ships only inside the product? Different bars for wording review.
6. **EIN.** Confirmed mostly non-public; is 990-derived coverage for co-ops/nonprofits worth a
   dedicated ingest, or drop EIN from the spine?
7. **Data licensing.** CORES/499/ASR/ULS/EDGAR are all public domain or open; PeeringDB has API terms;
   LERG/OCN and OpenCorporates are restrictive. Confirm before each ingest lands (rides the standing
   counsel dossier).
