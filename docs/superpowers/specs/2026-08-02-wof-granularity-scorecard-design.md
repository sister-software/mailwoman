# WOF granularity scorecard — design

**Date:** 2026-08-02
**Status:** design approved, plan not yet written
**Deliverable:** `mailwoman gazetteer granularity` — a per-country gazetteer depth scorecard with
gap attribution, emitted both machine-readable (coverage manifest) and human-readable (committed
markdown report).

## The question

We take Who's on First with the presumption that it is granular enough. Nobody has measured whether
that is true, and there is no instrument that would say so. Two consequences follow:

1. We cannot answer "is WOF granular enough?" for any country, let alone worldwide — and full world
   coverage is the end game.
2. We cannot rank what to add to the gazetteer to maximize parsability, because we do not know where
   it is thin. The POI work started partly because the deep end of WOF was opaque from the outside.

This design is the instrument. It answers (1) with a number per country per rung, and its output is
the ranked work list for (2).

## What was measured before designing

Everything below is from probes run 2026-08-02 against the shipped artifacts. The throwaway scripts
live under `scripts/diagnostic/` (gitignored by convention — one-off investigation scripts, per
`.gitignore`'s diagnostic-scripts section); their logic is what the command productionizes.

### Finding 1 — the shipped gazetteer stocks 9 of 34 placetypes

Global census of `admin-global-priority.db` (`spr`, current + non-deprecated):

| placetype     |      rows | countries |
| ------------- | --------: | --------: |
| locality      | 3,731,863 |       244 |
| neighbourhood |   159,398 |    **11** |
| localadmin    |   112,023 |        24 |
| county        |    36,672 |        87 |
| region        |     4,299 |       227 |
| macrocounty   |       467 |         4 |
| country       |       237 |       237 |
| borough       |       210 |         6 |
| macroregion   |        65 |         5 |

Zero rows for the other 25 placetypes in the WOF vocabulary, including the entire venue/sub-venue
deep end (`venue`, `building`, `campus`, `wing`, `concourse`, `arcade`, `enclosure`,
`installation`), the address-grounding pair (`address`, `intersection`), the hood variants
(`macrohood`, `microhood`), and `postalcode`.

**The headline: `dependent_locality` exists in 11 of 244 countries. 233 countries bottom out at
`locality`.** The deep end is not a mystery — in the shipped artifact it is empty.

The 11, by node count: DE 67,162 · US 49,491 · GB 13,177 · NL 11,965 · JP 7,759 · FR 5,321 ·
TW 1,450 · ES 1,266 · IT 1,137 · KR 693 · CN 187. All 244 countries have a locality tier.

NZ is **not** among them, yet NZ ships a pair index (`pair-index-nz.bin`). That confirms the pair
index never depended on gazetteer sub-locality nodes — NZ's came from LINZ. Gazetteer depth and pair
coverage are independent axes, and the scorecard must not conflate them.

### Correction (2026-08-02, after the plan's PR A+B landed)

**The 11 are exactly the countries whose WOF repo the build clones.**
`DEFAULT_WOF_PRIORITY_COUNTRIES` (`gazetteer-pipeline/defaults.ts:20`) is CN, DE, ES, FR, GB, IT,
JP, KR, NL, TW, US — the same eleven, in the same set. Verified against
`$MAILWOMAN_DATA_ROOT/wof/repos`, which holds those repos and no others.

**WOF publishes 260 per-country admin repos.** The recipe ingests 11. Everything else arrives via
Overture divisions — whose `OVERTURE_DIVISION_SUBTYPES` carries no hood-level subtype — or the
GeoNames alias fold. Repos exist and are substantial for countries we have never touched: IN 2,230 MB
(larger than the US's 1,858 MB), FR-sized PL at 482 MB, BR 303 MB, NZ 235 MB, IE 114 MB.

So the "dependent_locality in 11 of 244" headline is a true statement about the **artifact** and a
false one about **WOF**. Nothing here has tested whether WOF is granular enough outside those eleven
countries, because outside them WOF was never asked. Ireland is the sharpest case: this spec framed
IE's zero as a WOF gap that Overture could fill, and the cheaper reading is that
`whosonfirst-data-admin-ie` exists, is 114 MB, and has never been cloned.

Repo size is not placetype depth — how much of those 249 repos is sub-locality tier is **unmeasured**,
and measuring it is the source-gap leg below.

### Finding 2 — a chunk of that is an allowlist, not a data gap

`ADMIN_PLACETYPES` (`mailwoman/gazetteer-pipeline/admin/ingest-wof.ts:27`) is a hardcoded
9-element set — precisely the 9 placetypes above. Every other placetype is dropped at ingest by a
code constant, before WOF's actual contents matter. `macrohood`/`microhood` are in
`PLACETYPE_PROJECTION` and project onto `dependent_locality`, but the ingest never asks for them.

`placetype-census.ts`'s docstring already notes the priority build "does not stock" those rows and
that their absence is coverage rather than fact. That is true and understated: for the allowlisted-
out placetypes it is not a coverage gap at all, it is a one-line recipe decision nobody has revisited.

How much of the deficit this explains is **unmeasured** — it depends on what the cloned
`whosonfirst-data*` repos actually contain per placetype per country, which the scorecard measures.

### Finding 3 — WOF's sub-locality depth vs Overture, 10-country probe

Sub-locality nodes (`borough` + hood family) in the shipped DB vs Overture `divisions` @ release
`2026-06-17.0` (`macrohood` + `neighborhood` + `microhood`; Overture publishes no `borough` subtype
rows for these countries):

| country | WOF (shipped) | Overture |       ratio |
| ------- | ------------: | -------: | ----------: |
| DE      |        67,162 |   27,156 | 2.5× richer |
| NL      |        11,965 |    5,162 | 2.3× richer |
| GB      |        13,177 |   11,196 | 1.2× richer |
| US      |        49,491 |   59,600 |        0.8× |
| FR      |         5,321 |   50,782 |   **0.10×** |
| ES      |         1,266 |   42,038 |   **0.03×** |
| IT      |         1,137 |   30,101 |   **0.04×** |
| JP      |         7,759 |  210,631 |   **0.04×** |
| IE      |         **0** |   51,778 |           — |
| NZ      |         **0** |      992 |           — |

Two notes that make this usable:

- **Not circular.** `fold-overture.ts`'s `OVERTURE_DIVISION_SUBTYPES` is
  `["country","locality","region","county","localadmin"]` — no hood-family subtype has ever entered
  the DB, so Overture's sub-locality tier is an independent second opinion here. The locality rung
  and above ARE partly Overture for the 86-country backfill set, and those cells are self-comparison.
- **IE's deferred blocker may have moved.** `placetype-evidence.mdx` parks Ireland on a licence
  survey (Tailte Éireann, logainm). Overture ships 51,778 IE sub-locality nodes under ODbL today and
  WOF has zero. This is the Northern Ireland lesson again: "worth re-reading any deferred blocker
  after a premise moves."

### Finding 4 — the demand-side instrument is blind below the locality line

The intuitive design ("use Overture `address_levels` to learn what depth addresses actually write,
compare to WOF") does not reach the tier we care about. Measured depth distributions, release
`2026-06-17.0`:

| country | `len(address_levels)` | levels                     |
| ------- | --------------------: | -------------------------- |
| ES      |              1 (100%) | municipality only          |
| NL      |              1 (100%) | municipality only          |
| DE      |              2 (100%) | state code → municipality  |
| IT      |              3 (100%) | region → province → comune |

None reach dependent_locality. So `address_levels` can grade WOF at the locality rung and above and
nothing below it. Two further limits on the same source:

- **GB and IE `addresses-*.parquet` are 532 bytes** — effectively empty. Overture's addresses theme
  is largely OpenAddresses-derived and neither Royal Mail PAF nor Tailte Éireann is open. The
  instrument is blind exactly where the shipped pair-index work lives.
- **The local extracts are `LIMIT`-capped at 800k rows, head-of-scan** (`overture-ingest.tsx:141`).
  DE's extract covers 4 of 16 states (SL, RP, BW, NW). They cannot support a national claim as-is.

This is why the address-grounded ("demand side") leg is **deferred, not included** — see Deferred.

### Finding 5 — prose and executable projection have drifted, onto a landmine

`PLACETYPE_PROJECTION` (`mailwoman/gazetteer-pipeline/placetype-census.ts:41`) maps 25 keys. The WOF
vocabulary is 34. The 9 unmapped keys are exactly the deep-end rungs:

```
address  arcade  building  campus  concourse  enclosure  installation  intersection  wing
```

The prose table in `docs/articles/plan/reference/placetype-evidence.mdx` names all of them; the code
does not. By deliberate design an unmapped placetype makes the census build **throw** rather than
silently go uncounted. So the moment anyone deepens the gazetteer past the current allowlist,
`mailwoman gazetteer census` breaks. Closing this is a prerequisite of the scorecard work, not a
follow-up.

### Finding 6 — the uncloned repos probed: it varies per country, and neither source wins

Shallow-cloned three uncloned admin repos and tallied `wof:placetype` the way `ingest-wof.ts` reads
them (skip superseded, exclude `*-alt-*.geojson`), against Overture `divisions` @ `2026-06-17.0`:

| country | WOF repo sub-locality | Overture sub-locality |        verdict |
| ------- | --------------------: | --------------------: | -------------: |
| IN      |           **189,026** |                74,920 |  **WOF ~2.5×** |
| IE      |                   152 |                51,778 | Overture ~340× |
| NZ      |             **1,894** |                   992 |  **WOF ~1.9×** |
| BR      |                   848 |                64,537 |  Overture ~76× |

Control (a repo we DO clone, to validate the method): GB tallies **13,225** sub-locality nodes in the
repo against **13,177** in the shipped DB — the delta is the superseded/current filter, so the probe
reads the repos the way the build does.

**India is the largest untapped tier found anywhere.** 189,026 sub-locality nodes exceeds Germany's
67,162, the richest tier mailwoman currently ships, and India is not in the recipe at all. Its repo
also carries `macrohood` (24) and `borough` (78) rows — the `macrohood` ones drop at ingest even for
a cloned country, since `ADMIN_PLACETYPES` omits that placetype.

**No global rule survives this.** Ireland's WOF repo is genuinely thin — 152 neighbourhoods against
Overture's 51,778 — which vindicates the original "Overture is the fix for IE" framing, not the
recipe-gap correction. New Zealand inverts it: WOF holds 1,894 neighbourhoods, nearly double
Overture's 992, and mailwoman ships **zero** because the repo was never cloned. Brazil looks like
Ireland at a different scale.

So "is WOF granular enough?" has no country-independent answer, and neither does "should we prefer
Overture?" The scorecard carrying both columns per country is therefore not redundancy — it is the
only defensible shape. This is what makes the ABSENT/MISTYPED name match load-bearing rather than a
refinement.

#### And node counts do not survive conversion to pairs

The obvious next move was "add NZ to `DEFAULT_WOF_PRIORITY_COUNTRIES`, it beats Overture." Measuring
the pair yield killed it. A pair needs the child's locality parent to resolve — via `wof:hierarchy`'s
`locality_id`, which is what `freeze.ts`'s `backfillAncestorsFromHierarchy` reads:

| country     | sub-locality nodes | usable pairs | conversion |
| ----------- | -----------------: | -----------: | ---------: |
| IN          |            189,026 |  **186,469** |      98.6% |
| GB (cloned) |             13,225 |       13,094 |        99% |
| IE          |                152 |          151 |        99% |
| BR          |                848 |          774 |        91% |
| NZ          |              1,894 |      **280** |    **15%** |

**NZ's hierarchy is broken at the locality tier.** 1,637 of its sub-locality records carry
`locality_id: -1` and `wof:parent_id: -1` — WOF parents them straight to the region, skipping the
locality entirely (`Omanu Beach`, `Koutu`, `Hairini` all read
`{"country_id":85633345,"locality_id":-1,"region_id":85687175}`). So NZ's apparent 1.9× win over
Overture is a node-count artifact; in the campaign's actual currency it yields 280 pairs, and
Overture's 992 macrohoods carry `parent_division_id`.

**Conversion ranges from 15% to 99%.** Ranking gazetteer work by node count is therefore not a
shortcut with acceptable error — it is wrong by up to 6×, and wrong in a way that inverts the
ordering. The pair-yield column is load-bearing, not a refinement, and the scorecard must never
present a node count as an opportunity estimate.

#### The headline the probe was looking for

**India yields 186,469 pairs at 98.6% conversion, from a repo we have never cloned.**

For scale: the shipped GB pair index is **30,834** pairs, assembled across eight campaign rungs from
HM Land Registry PPD, ONSPD wards, and WOF — months of sourcing, each rung boarded against venue
confounds before shipping. India is 6× that, and the acquisition cost is a `git clone` plus one entry
in `DEFAULT_WOF_PRIORITY_COUNTRIES`. Samples read correctly: `Mulund East / Mumbai`,
`Rajbagh / Srinagar`, `Fort / Tiruchchirappalli`, `Pedaganayada / Visakhapatnam`.

**This is the answer to the "what maximizes parsability" half of the originating question**, and it
was never a modelling problem or a sourcing problem. It was a recipe constant.

Three honest caveats before anyone treats 186,469 as shippable:

- **A pair count is not a parse improvement.** Every GB rung cleared a venue-confound board at 0 false
  positives before shipping; IN has had no board built. The doctrine that governed GB governs this.
- **IN needs a carrier package.** The pair index is hard-gated on the resolved locale's country, so an
  artifact shipped inside another locale's package can never fire — IN needs its own
  `@mailwoman/neural-weights-*` overlay first, the same blocker `placetype-evidence.mdx` records for
  IE/DE/ES/IT.
- **Whether Indian postal format writes a dependent-locality line is unverified here.** `Mulund East,
Mumbai` suggests yes, but the demand-side check does not exist for this tier (Finding 4), so that
  remains an assumption rather than a measurement.

Two incidental confirmations that PR A was necessary: the IE and BR repos carry `campus` rows (2 and
24), and NZ carries `marinearea` (84) and `dependency` (2). All four are placetypes
`ADMIN_PLACETYPES` drops today and that `PLACETYPE_PROJECTION` did **not** map before PR A — so
widening the ingest allowlist without PR A would have made `mailwoman gazetteer census` throw, which
is exactly the landmine PR A was written to defuse.

## The scorecard

### Unit and rungs

The unit is **(country × rung)**, worldwide — every country the gazetteer knows, not a chosen list.

Rungs are derived from `PLACETYPE_PROJECTION` rather than hand-written, so the scorecard and the
census can never disagree about what projects where. Rungs are named in `ComponentTag` terms because
that is the vocabulary the decoder consumes:

| rung                 | WOF placetypes                                                                   | Overture subtypes                        | source               |
| -------------------- | -------------------------------------------------------------------------------- | ---------------------------------------- | -------------------- |
| `country`            | `country`, `nation`, `dependency`, `disputed`                                    | `country`                                | admin DB             |
| `region`             | `region`, `macroregion`                                                          | `region`                                 | admin DB             |
| `subregion`          | `county`, `macrocounty`                                                          | `county`                                 | admin DB             |
| `locality`           | `locality`, `localadmin`                                                         | `locality`, `localadmin`                 | admin DB             |
| `dependent_locality` | `borough`, `neighbourhood`, `macrohood`, `microhood`                             | `macrohood`, `neighborhood`, `microhood` | admin DB             |
| `venue`              | `venue`                                                                          | —                                        | `poi.db`             |
| venue sub-structure  | `building`, `campus`, `wing`, `concourse`, `arcade`, `enclosure`, `installation` | —                                        | `poi.db` (see below) |

Context-only and out-of-grammar placetypes (`metroarea`, `marketarea`, `postalregion`, `timezone`,
`continent`, `ocean`, `marinearea`, `planet`, `empire`) project to `null` and are **excluded from the
ladder** — they are conditioning features and annotation surfaces, never emitted spans. They still
appear in a footer count so "we looked and deliberately skipped these" stays distinguishable from
"we never looked."

`postcode` is also excluded. It is an orthogonal channel rather than a containment rung — the
postcode-anchor channel already ships, `postalcode` is allowlisted out of the admin build and has its
own build path, and folding it into a depth ladder would make "bottoms out at" incoherent.

`poi.db` already carries `layer_manifest` + `layer_coverage`, so the venue rung reads through the
existing layer contract rather than new plumbing.

### The derived headline column

**"bottoms out at"** — the deepest rung a country actually reaches. Density is measured with the
statistic the placetype census already validated rather than a fresh invention: **parent-coverage
share**, the fraction of a country's locality-class nodes carrying at least one child projecting onto
that rung.

That choice is deliberate. The census probe measured GB's share at **33.2%** of 16,987 locality-class
surfaces and found it to be real conditional evidence (a hit rules out two thirds of the parent
population), while _within-node_ share carried no information at all — WOF rarely parents a locality
under a locality, so covered nodes read ~100% across the board. Presence and magnitude across the
parent population are the statistics that discriminate; use those.

Default floor: **5% parent-coverage share**, printed in the report and revisable in the plan. A
country below the floor at a rung is recorded as reaching the rung above it, with the measured share
shown so a near-miss stays visible rather than being rounded into absence.

One column, 244 rows, and it is the world map of where mailwoman's gazetteer stops. This is the
direct answer to the originating question.

### Gap attribution

A count alone routes nowhere. Every thin or empty cell is attributed by walking down:

1. **Recipe gap** — the country is absent from `DEFAULT_WOF_PRIORITY_COUNTRIES`, so no WOF repo was
   ever cloned or ingested for it. Fix: clone the repo and add the country to the recipe. **This is
   the dominant class — 233 of 244 countries — and it was missed in the first draft of this spec.**
   A recipe-gap cell says nothing about WOF's depth.
2. **Allowlist gap** — the placetype is absent from `ADMIN_PLACETYPES`. Fix: one-line recipe change
   plus a rebuild. Covers 25 of 34 placetypes, and applies even to the eleven cloned countries.
3. **Source gap** — the country is cloned and the placetype allowlisted, but the repo holds no such
   rows. Fix: another provider (Overture divisions, `poi.db`, a national register). **This is the
   only class that is a genuine statement about WOF**, and today it can only be evaluated for eleven
   countries.
4. **Build gap** — ingested but missing downstream (freeze, priority filter, dedup). Fix: a bug.

Attribution (1) is free — a set membership test against `defaults.ts`, shipped in PR B as the
report's `source` column. Attribution (3) requires counting placetypes on disk in the WOF repo set.
`ingest-wof.ts` globs `**/data/**/*.geojson` under discovered roots; the scorecard needs the same
discovery and a per-(country, placetype) tally, which means parsing `wof:placetype` out of each
feature — the repos carry no `meta/` CSV shortcut.

**Open question 1 is resolved.** The repos are at `$MAILWOMAN_DATA_ROOT/wof/repos` (the default the
`gazetteer build admin --data` flag documents), holding the eleven priority admin repos plus eight
`whosonfirst-data-postalcode-*`. The design-stage claim that they were missing was a truncated
directory listing, not a fact.

### Name match — missing vs mistyped

The leg that stops the scorecard from lying. Each Overture sub-locality surface is classified against
WOF, folded through `foldName` (`resolver/fold-name.ts`), scoped to country:

- **ABSENT** — no WOF row of any placetype carries the surface. Genuine coverage gap; fix is ingestion.
- **MISTYPED** — WOF has the surface at a placetype projecting onto a different `ComponentTag`
  (Shoreditch as `locality`, not `neighbourhood`). Fix is re-projection or re-parenting, and costs
  nothing to acquire.
- **PRESENT** — WOF has it at a rung that projects the same way.

Without this leg the raw ratios are uninterpretable. DE reads 2.5× richer, but if its 67k
`neighbourhood` rows do not correspond to the surfaces Overture names, that number means nothing.
ABSENT and MISTYPED route to two entirely different pieces of work.

### Pair yield

One column per country, in the campaign's own units: (child, parent) pairs derivable from Overture
`divisions` via `parent_division_id`, after the register-vs-writer folding rules the GB rungs paid
for and which `placetype-evidence.mdx` records as general:

- A slash-separated parent (`Londonderry / Derry`) is an **alias set**, not a name — emit one pair per
  alternative, or the pair ships dead (folds to a key matching neither alternative).
- A civil-parish suffix (`Pontypridd Community`, `Llanelli Rural`) is administrative furniture —
  strip it rather than dropping the pair (1,545 Welsh pairs would otherwise have been discarded).

Split **new** vs **already in the shipped index**, so IE's 51,778 nodes become a number the campaign
can schedule against rather than an impression.

A row then reads as a routed work item:

> `IE / dependent_locality — allowlist+source gap; WOF 0, Overture 51,778; N ABSENT / M MISTYPED; yields P new pairs`

## Outputs

Following the doctrine in `coverage-manifest.ts` — facts about an artifact live in the artifact's
manifest, read at load, so they update at gazetteer **rebuild** rather than at a code PR:

1. **Machine-readable.** The per-country depth record emitted into the gazetteer's coverage manifest
   at build time, so downstream consumers can know JP bottoms out at `locality` instead of assuming
   otherwise. The **meaning-of-zero rule is honored structurally**: a measured-and-empty rung is a
   present row with a zero count; a never-measured rung is an absent row. These must never collapse
   into the same representation.
2. **Human-readable.** A release-pinned markdown scorecard committed under
   `docs/articles/evals/coverage/`, following the `fill-rates.md` precedent.

Command: `mailwoman gazetteer granularity`, alongside the existing `census` / `verify` /
`overture-ingest` subcommands (`mailwoman/commands/gazetteer/`), built on `cli-kit`'s
`useCommandTask` per the Pastel convention. The Overture release is pinned in every artifact path
and printed in the report header, per the standing rule in `overture-ingest.tsx`.

## Prerequisite

Extend `PLACETYPE_PROJECTION` to all 34 WOF placetypes (Finding 5), with a test asserting total
coverage of the vocabulary so the prose/code drift cannot recur. The 9 additions are deep-end rungs
whose projections the prose table already specifies: `building`/`campus`/`wing`/`concourse`/`arcade`/
`enclosure`/`installation` → venue and unit sub-structure; `intersection` → `intersection`;
`address` → house_number/street grounding.

This lands **before** the scorecard, because the census build throws on an unmapped placetype and the
scorecard's whole purpose is to justify deepening the gazetteer past the current allowlist.

## Limits the report declares about itself

Printed in the report, not just recorded here:

- **Counts are not quality.** Overture divisions rows are OSM-derived and unaudited for duplicates,
  noise, and address-relevance. A count comparison establishes where to look, never that the rows are
  good.
- **No demand-side grounding below the locality line.** Nothing in this scorecard proves a
  sub-locality surface appears in real addresses. `address_levels` bottoms out at municipality
  (Finding 4).
- **GB and IE have no usable Overture address data at all** (532-byte parquets).
- **The local address extracts are `LIMIT`-capped at 800k, head-of-scan**, and are not a national
  sample.
- **The locality rung and above are self-comparison for the 86-country Overture backfill set.** Those
  cells are marked; the sub-locality rung is not affected, since no hood subtype has ever been
  ingested.
- **Placetype vocabulary differs across sources** — Overture `neighborhood` vs WOF `neighbourhood`,
  and Overture publishes `localadmin` only for FR in the probed set.

## Testing

The fixtures → smoke → full ladder from `poi-layer-runbook.mdx`:

1. **Unit** — `foldName` behavior and the three-way gap attribution against a small fixture admin DB
   with hand-placed rows covering each outcome; plus the `PLACETYPE_PROJECTION` completeness test
   from the prerequisite.
2. **Smoke** — 3 countries spanning the outcome space: DE (WOF-rich), IE (WOF-empty, Overture-rich),
   JP (WOF thin against a 27× Overture tier).
3. **Full** — the global run, output diffed against the smoke rows for those 3 countries.

Table DDL for any new manifest table goes through Kysely's schema builder with a co-located typed
`Database` interface, per the repo convention. The DB is rebuilt and swapped, never patched.

## Deferred

- **The address-grounded demand leg.** Rejected for now on structure, not cost: the measurement that
  matters (does this sub-locality surface appear in real addresses?) is exactly what `address_levels`
  cannot see. Revisit if a sub-municipality demand source appears — OSM `addr:suburb`, Overture
  places addresses, or per-country registers.
- **Acting on the findings.** Widening `ADMIN_PLACETYPES`, ingesting Overture's hood tier, or
  building new pair indexes are all separate work, gated by the doctrine that already governs them:
  positive evidence only, bias never mask, a venue-confound board before any pair batch ships, and
  the D-rule (no default-on mechanism ships with a known regression on any tier-1 locale). The
  scorecard justifies and orders that work; it does not perform it.
- **A standing verify gate.** Adding granularity checks to `verifyAdmin()` so a rebuild that loses
  depth fails the gate is a natural follow-up once the baseline numbers exist and are trusted.

## Suggested PR split

The work is coherent but larger than one review. Following the `gazetteer-cli-pr-c/d/e` precedent in
`docs/superpowers/plans/`:

- **PR A — prerequisite.** Extend `PLACETYPE_PROJECTION` to all 34 placetypes plus the completeness
  test. Small, mechanical, independently reviewable, and it unblocks anything that deepens the
  gazetteer. Ships alone.
- **PR B — the ladder.** `mailwoman gazetteer granularity` with the admin-DB rungs, parent-coverage
  share, the "bottoms out at" column, and the markdown report. Delivers the answer to the originating
  question on its own.
- **PR C — attribution + name match.** Allowlist/source/build attribution and ABSENT/MISTYPED/PRESENT.
  Turns the report from a diagnosis into a work list.
- **PR D — pair yield + manifest emission.** The campaign-currency column and the machine-readable
  record in the coverage manifest.

B is useful without C and D. If the WOF repo set turns out to be unavailable (Open question 1), C
ships with the source-gap leg reporting "unknown" rather than blocking.

## Open questions for the plan stage

1. ~~Where are the cloned `whosonfirst-data*` repos?~~ **Resolved 2026-08-02:**
   `$MAILWOMAN_DATA_ROOT/wof/repos`, holding the eleven priority admin repos. The source-gap leg is
   unblocked for those eleven; for the other 249 it needs the repo cloned first, which is now its own
   piece of work (see the new open question 4).
2. Whether the venue sub-structure rungs collapse into one `venue` row for v1. `poi.db` answers venue
   density but does not carry WOF's building/campus/wing distinctions, so the sub-structure rungs may
   have no measurable source yet — in which case they are **absent** rows, not zero rows. Getting
   this wrong violates the meaning-of-zero rule in the artifact itself.
3. Whether the 5% parent-coverage floor is right. GB sits at 33.2%, so the floor is far below the one
   country we have a validated reading for. It wants a second calibration point before it hardens.
   **PR B supplied four:** DE 72.6%, GB 34.7%, plus NL and US above the floor, against JP at 0.6% —
   a wide gap between the countries that reach the tier and the ones that do not, which suggests the
   floor's exact value matters less than expected.
4. ~~How much of the 249 uncloned admin repos is sub-locality tier?~~ **Probed 2026-08-02 — see
   Finding 6.** The answer is "it varies enormously, and neither source dominates," which settles the
   design question: the scorecard must carry both columns per country, and no global
   source-preference rule is defensible.
