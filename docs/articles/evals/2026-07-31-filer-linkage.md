# 2026-07-31 — filer.db record linkage vs held-out FRN↔holdingCompany truth (3b task 4)

**Verdict: the shipped entity linkage does not recover corporate-family membership when `holdingCompany` is withheld — F1 0.000 (precision N/A, recall 0.000) over 4 held-out truth-positive pairs.** This is not a tuning miss: the two mechanisms that make `cluster-filers.ts` safe against false-identity merges — the `relationship: same_entity` filter on authoritative clustering (Task 3's CRITICAL fix) and the hard identifier veto on the inferred pass (the 3a review's fix) — are exactly the mechanisms that make family recovery from name/identifier signal alone structurally unreachable. `filer_family` gets its membership by reading a disclosed field (`build-filer.ts`), never by inferring one; this eval measures what happens when that field is the thing under test instead of the thing on the table.

## The experiment

Truth: two FRNs belong to the same corporate family iff their real (never-stripped) `holdingCompany` values canonicalize to the same string, via `mintFamilyID` — the identical rule `buildFilerDatabase` itself uses to derive `filer_family.family_id`, so truth is stated in exactly the terms the writer would have used had the field survived. Input: the SAME corpus with `holdingCompany` cleared on every row (`buildFilteredEvalInputs`, `filer/tools/linkage-eval.ts`) BEFORE `buildFilerDatabase` ever runs — no `family_id`, no `HoldingCompany`-relationship edge, and no `filer_family` row can exist in the artifact this eval builds, because nothing in the input asserts one. `clusterAuthoritativeComponents`/`clusterInferredLinks` then run UNMODIFIED against that artifact (same identifier veto over `frn`/`form499ID`/`providerID`, same `learnedScorer: false`, same exact-canonical-name blocking) — nothing about the matcher's configuration changes for this eval. Two FRNs are predicted the same family iff they land in the same authoritative `filer_cluster` OR the same inferred `filer_cluster`.

## Corpus

9 FRNs, authored (not sampled from a real FCC file) so every truth fact is auditable here rather than trusted from an external source. Two real multi-FRN families, each with one member reporting a spelling-drifted holding-company name; four standalone filers with no holding company, two of which (the last two rows) share a canonical legal name on purpose — a same-name/different-entity trap the identifier veto has to refuse to merge.

| FRN        | legal name (given to the matcher) | real holding company (withheld)    | truth family                                         |
| ---------- | --------------------------------- | ---------------------------------- | ---------------------------------------------------- |
| 9100000001 | Trailhead Broadband LLC           | Cascade Fiber Holdings, Inc.       | `holding_company_name:cascade fiber holdings`        |
| 9100000002 | Piedmont Rural Telephone Co       | Cascade Fiber Holdings Inc         | `holding_company_name:cascade fiber holdings`        |
| 9100000003 | Summit Ridge Communications Inc   | Cascade Fiber Holdings, Inc.       | `holding_company_name:cascade fiber holdings`        |
| 9100000004 | Bluegrass Rural Exchange Inc      | Meridian Communications Group LLC  | `holding_company_name:meridian communications group` |
| 9100000005 | Harborview Telecom Co             | Meridian Communications Group, LLC | `holding_company_name:meridian communications group` |
| 9100000006 | Lonestar Independent Telephone Co | _(none)_                           | _(standalone — no truth family)_                     |
| 9100000007 | Harbor Point Communications Inc   | _(none)_                           | _(standalone — no truth family)_                     |
| 9100000008 | American Fiber Partners LLC       | _(none)_                           | _(standalone — no truth family)_                     |
| 9100000009 | American Fiber Partners, LLC      | _(none)_                           | _(standalone — no truth family)_                     |

## Input record shape

Every field `buildFilteredEvalInputs()` hands to `buildFilerDatabase`, and whether the matcher sees it:

| Form499Row field             | given to the matcher? | note                                                                                    |
| ---------------------------- | --------------------- | --------------------------------------------------------------------------------------- |
| `form499ID`                  | yes                   |                                                                                         |
| `frn`                        | yes                   | the truth key, never itself withheld                                                    |
| `lastFiledAt`                | yes                   |                                                                                         |
| `usfContributor`             | yes                   |                                                                                         |
| `legalNameOfCarrier`         | yes                   | the inferred pass's blocking key + score input                                          |
| `doingBusinessAs`            | yes                   |                                                                                         |
| `principalCommType`          | yes                   |                                                                                         |
| `holdingCompany`             | **no**                | **HELD OUT** — cleared to `""` on every row                                             |
| `managementCompany`          | yes                   | a separate ownership-vs-control field; never set equal to holdingCompany in this corpus |
| `hqAddress`                  | yes                   |                                                                                         |
| `customerInquiriesTelephone` | yes                   |                                                                                         |
| `customerInquiriesAddress`   | yes                   |                                                                                         |
| `dcAgentDisplayName`         | yes                   | attribute only — never an edge input (DC-agent doctrine)                                |
| `dcAgentOrganizationName`    | yes                   | attribute only — never an edge input                                                    |
| `dcAgentTelephone`           | yes                   |                                                                                         |
| `dcAgentEmailAddress`        | yes                   |                                                                                         |
| `dcAgentAddress`             | yes                   |                                                                                         |

| ProviderListRow field | given to the matcher? | note                                          |
| --------------------- | --------------------- | --------------------------------------------- |
| `providerID`          | yes                   |                                               |
| `frn`                 | yes                   | the truth key, never itself withheld          |
| `holdingCompany`      | **no**                | **HELD OUT** — cleared to `null` on every row |

## Results

| metric                                                        | value |
| ------------------------------------------------------------- | ----- |
| precision                                                     | N/A   |
| recall                                                        | 0.000 |
| F1                                                            | 0.000 |
| true-positive pairs                                           | 0     |
| false-positive pairs                                          | 0     |
| false-negative pairs                                          | 4     |
| truth-positive pairs (pairs the withheld field puts together) | 4     |
| predicted-positive pairs (pairs the linkage puts together)    | 0     |
| total pairs scored                                            | 36    |
| inferred pass: form499_id records considered                  | 9     |
| inferred pass: linked clusters (size > 1)                     | 0     |
| inferred pass: `filer_edge` rows written                      | 0     |

### Truth-positive pairs, individually

The only pairs the withheld field asserts are the same family — every other pair of the 9 FRNs (32 of them) is a truth negative:

| FRN A      | FRN B      | truth family                                         | recovered (authoritative)? | recovered (inferred)? |
| ---------- | ---------- | ---------------------------------------------------- | -------------------------- | --------------------- |
| 9100000001 | 9100000002 | `holding_company_name:cascade fiber holdings`        | no                         | no                    |
| 9100000001 | 9100000003 | `holding_company_name:cascade fiber holdings`        | no                         | no                    |
| 9100000002 | 9100000003 | `holding_company_name:cascade fiber holdings`        | no                         | no                    |
| 9100000004 | 9100000005 | `holding_company_name:meridian communications group` | no                         | no                    |

## Why the score is what it is

`clusterAuthoritativeComponents`'s `readAuthoritativeGroups` (`cluster-filers.ts`) unions ONLY `relationship: "same_entity"` authoritative edges — a `HoldingCompany`/`ManagementCompany` edge is never even a candidate for entity clustering (Task 3's CRITICAL fix; see that module's own docstring). With `holdingCompany` stripped, no such edge exists in this build anyway, so the point is moot for THIS run — but it means the authoritative pass was never capable of recovering family membership even when the field is present, which is the honest reason `filer_family` is populated by direct field extraction (`build-filer.ts`'s `insertFamilyMembership`) and not by this linkage. `clusterInferredLinks`'s `hasSharedIdentifier` veto forces any candidate pair with no shared `frn`/`form499ID`/`providerID` code to `-Infinity`, unconditionally, before name similarity is consulted — and two DIFFERENT FRNs structurally never share one of those codes (a shared code would mean a shared node, which the authoritative pass would already have merged). The corpus's namesake pair (`American Fiber Partners LLC` / `American Fiber Partners, LLC`) is the one candidate whose canonical organization names actually collide — it reaches the veto rather than being blocked out at the exact-name-blocking stage, and the veto correctly refuses to merge it (no shared identifier on either side). That refusal is precision working as designed, not a coincidence: this eval's 0 predicted-positive pairs is a DIRECT consequence of the veto and the relationship filter, over 9 form499_id records the inferred pass actually scored.

## Metric choice

Precision/recall/F1 here are PAIRWISE — over unordered FRN pairs, not over cluster-to-cluster alignment (B-cubed, the Hungarian algorithm) — the same choice `registry/tools/train-gbt.ts`'s (unexported) `clusterF1` makes for an analogous problem (does `resolveEntities`'s clustering recover the true NPI grouping?). It is not reused here: it hard-codes an NPI/`SourceRecord`-shaped input, and — more importantly — its convention of defaulting an empty denominator to `0` would have reported this eval's `predictedPositivePairs === 0` as "0% precision" indistinguishably from a linkage that confidently merged the wrong records everywhere. `linkage-metrics.ts`'s `scorePairwiseGrouping` (written for this task, exported) reports `null` for that case instead — see its docstring for the full rationale. Pairwise agreement is the right shape here specifically because an authoritative cluster's `cluster_id` is content-derived and has no aligned counterpart in the truth partition to match against; the only well-defined question is whether two records are correctly judged together or apart, which pairwise agreement answers without an alignment step.

## Leakage and reproducibility

SHA-256 of the matcher's inputs (the exact, holdingCompany-stripped `form499Rows`/`providerRows` bytes `buildFilerDatabase` received): `ce1f393611962e7a0f6747116c54a4c71ea9144049f2ece2c834154a89cb1957`.

The exclusion is structural, not a runtime check: `buildFilteredEvalInputs()` is the ONE function that builds what reaches `buildFilerDatabase`, and `linkage-eval.test.ts` asserts every row it returns carries a blank (`""`/`null`) `holdingCompany` — the same function this eval itself calls, not a parallel copy that could drift. Re-running `filerLinkageEval` reproduces byte-identical scores and the identical SHA every time: the corpus is a fixed, authored literal (no sampling, no randomness), `buildFilerDatabase`/`clusterFilers` are already deterministic by construction (content-derived cluster ids, no reliance on row-iteration order — see `cluster-filers.ts`'s own idempotency discipline), and `sourceVintage`/`validFrom` are fixed constants rather than "today". `linkage-eval.test.ts` pins this by running the eval twice and asserting the two score objects and SHAs are identical.

## Honest caveats

This is a synthetic, small (9-FRN) corpus, not a run against real FCC Form 499 data — no such corpus is available in this repo with a stable hash to pin to, so the eval is exact and reproducible at the cost of being small. The outcome is STRUCTURALLY determined by `cluster-filers.ts`'s current design (the relationship filter, the identifier veto), not sample-dependent — a larger or differently-drawn corpus of the same shape would score identically for the same reason, so more data would not change this finding, only its N. Recovering corporate family from evidence OTHER than a disclosed `holdingCompany` field — a normalized HQ address, a shared contact phone/email, once CORES/EDGAR data lands — is out of scope for this task and for `cluster-filers.ts` as it exists today; that gap is already named in that module's own "Degenerate discovery scope" note (3a Task 6) as deferred, not overlooked.
