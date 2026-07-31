# 2026-07-31 — does filer.db recover corporate family without the disclosed parent? (3b task 4)

**Corporate-family membership resolves correctly when the filer discloses its parent, and not at all when it doesn't.** Given the corpus with `holdingCompany` present, `filer.db` puts every one of the 6 same-family registrant pairs in the same family and invents none: precision 1.000, recall 1.000. Given the same corpus with that one field removed, it makes no family call at all — 0 of 6 pairs recovered, recall 0.000, precision and F1 undefined because there were no positive calls to score. Family membership in this pipeline is a disclosed field, transcribed and canonicalized; nothing in the build infers one from anything else.

## The question

A corporate family is a set of operating companies under one parent. `filer.db` builds families from the parent name a filer discloses — on its Form 499, or on the broadband provider list, whichever carries it; both sources contribute rows to the control build below. The open question this eval exists to baseline is whether that membership is recoverable for a filer that discloses NOTHING — from names, identifiers, or any other signal already in the pipeline. Today the answer is no, and the number below is what "no" measures as, so that a later build with more evidence has something to beat.

## The two runs

Both runs build a real scratch `filer.db` from the same authored corpus with the same shipped code, and read the prediction the same way. They differ in one field.

- **withheld** — `holdingCompany` cleared on every Form 499 row and every provider-list row before the builder sees it. The measurement.
- **control** — the identical corpus, that field intact. The check on the harness.

The control run is not an achievement and should not be read as one. A pipeline whose entire family mechanism is "copy the parent name the filer wrote down, canonicalize it, and group by the result" is supposed to score 1.000 when handed that name. Its job here is narrower and more important: it proves this harness reads a table the truth can actually reach. Without it, the withheld run's zero is unfalsifiable — an eval pointed at the wrong table reports zero too, and reports it just as confidently with the answer sitting in the artifact. The two runs differ in exactly one field, and the input hashes below differ accordingly.

### What counts as a prediction

Two registrants are predicted to be the same family iff the built `filer.db` places them in a common family as of 2026-06-01. Each membership is read with the shipped corporate-family reader, the one a product caller uses — but the eval composes it: that reader answers strictly per node, and a registrant can own several nodes (its FRN registrations and its provider id), so the eval takes the union across them. The reader is shipped; the union is this eval's own step, and it is why a parent disclosed on one of a registrant's two filings still counts.

Membership rows that exist only because two filers named the same MANAGEMENT company are excluded from both the prediction and the truth: management is operational control, not ownership; that field is not withheld here; and letting it answer would mean a field this eval hands over deciding a question about the field it holds back. The corpus includes two filers reporting the same manager so that exclusion has something to do.

### What counts as a registrant

The unit scored is the registrant, not the FRN. One operator can hold several FRN registrations — the corpus has one that holds two, joined by a shared provider id — and a parent disclosed on one registration is a fact about the company, not about that registration. Scoring FRNs individually would have let the truth partition put a single legal entity in two different families at once.

Treating a shared provider id as proof of one registrant is a modelling choice, not a law: real provider-list rows sharing a provider id have been observed reporting DIFFERENT parents, which would mean the fold is joining companies that ought to stay apart. That failure is not silent here. Folding two registrants that belong to different families puts a truth-negative pair inside one truth group, the control run cannot recover it, control recall drops below 1.000, and the test asserting a perfect control fails. The rule is load-bearing and wired to a tripwire.

## Corpus

12 Form 499 filers folded into 11 registrants, authored rather than sampled so every truth fact is auditable here instead of trusted from an external source. Two multi-member families whose members spell the parent name inconsistently; four standalone filers; a pair of unrelated companies with identical canonical names; one registrant holding two FRNs where only the second discloses the parent; and one filer that discloses no parent but names the same MANAGEMENT company as a member of the first family, which the prediction has to decline to treat as ownership. Every row is in the table below; the counts in this paragraph add up to it.

| FRN        | legal name (always given)         | registrant | holding company (withheld)         | management company       | truth family                                         |
| ---------- | --------------------------------- | ---------- | ---------------------------------- | ------------------------ | ---------------------------------------------------- |
| 9100000001 | Trailhead Broadband LLC           | itself     | Cascade Fiber Holdings, Inc.       | _(none)_                 | `holding_company_name:cascade fiber holdings`        |
| 9100000002 | Piedmont Rural Telephone Co       | itself     | Cascade Fiber Holdings Inc         | _(none)_                 | `holding_company_name:cascade fiber holdings`        |
| 9100000003 | Summit Ridge Communications Inc   | itself     | Cascade Fiber Holdings, Inc.       | Timberline Management Co | `holding_company_name:cascade fiber holdings`        |
| 9100000004 | Bluegrass Rural Exchange Inc      | itself     | Meridian Communications Group LLC  | _(none)_                 | `holding_company_name:meridian communications group` |
| 9100000005 | Harborview Telecom Co             | itself     | Meridian Communications Group, LLC | _(none)_                 | `holding_company_name:meridian communications group` |
| 9100000006 | Lonestar Independent Telephone Co | itself     | _(none)_                           | _(none)_                 | _(no family)_                                        |
| 9100000007 | Harbor Point Communications Inc   | itself     | _(none)_                           | _(none)_                 | _(no family)_                                        |
| 9100000008 | American Fiber Partners LLC       | itself     | _(none)_                           | _(none)_                 | _(no family)_                                        |
| 9100000009 | American Fiber Partners, LLC      | itself     | _(none)_                           | _(none)_                 | _(no family)_                                        |
| 9100000010 | Cedar Hollow Telephone Co         | itself     | _(none)_                           | _(none)_                 | `holding_company_name:meridian communications group` |
| 9100000011 | Cedar Hollow Wireless LLC         | 9100000010 | Meridian Communications Group, LLC | _(none)_                 | `holding_company_name:meridian communications group` |
| 9100000012 | Ridgeline Communications LLC      | itself     | _(none)_                           | Timberline Management Co | _(no family)_                                        |

## Input record shape

Every field the builder receives in the withheld run, and how much of it the corpus actually fills in. The empty columns are worth reading, but not for the obvious reason: filling them in changes nothing, because nothing on the family path reads them (see "What would move this number" below). They are listed so the corpus's sparsity is not mistaken for the reason the withheld run scores zero.

| Form499Row field             | in the withheld input? | populated in the corpus | note                                                                             |
| ---------------------------- | ---------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `form499ID`                  | yes                    | 12 of 12                |                                                                                  |
| `frn`                        | yes                    | 12 of 12                | the truth key, never itself withheld                                             |
| `lastFiledAt`                | yes                    | 12 of 12                |                                                                                  |
| `usfContributor`             | yes                    | **0 of 12** — never set |                                                                                  |
| `legalNameOfCarrier`         | yes                    | 12 of 12                | the entity-resolution pass's blocking key and score input                        |
| `doingBusinessAs`            | yes                    | 2 of 12                 |                                                                                  |
| `principalCommType`          | yes                    | 12 of 12                |                                                                                  |
| `holdingCompany`             | **no**                 | **withheld**            | the field under test                                                             |
| `managementCompany`          | yes                    | 2 of 12                 | control, not ownership — kept in the input, excluded from the prediction         |
| `hqAddress`                  | yes                    | **0 of 12** — never set | staged as an attribute; no code on the family or entity-resolution path reads it |
| `customerInquiriesTelephone` | yes                    | **0 of 12** — never set | staged as an attribute; no code on the family or entity-resolution path reads it |
| `customerInquiriesAddress`   | yes                    | **0 of 12** — never set | staged as an attribute; no code on the family or entity-resolution path reads it |
| `dcAgentDisplayName`         | yes                    | **0 of 12** — never set | attribute only — never an edge input (shared-agent doctrine)                     |
| `dcAgentOrganizationName`    | yes                    | **0 of 12** — never set | attribute only — never an edge input                                             |
| `dcAgentTelephone`           | yes                    | **0 of 12** — never set | attribute only — never an edge input                                             |
| `dcAgentEmailAddress`        | yes                    | **0 of 12** — never set | attribute only — never an edge input                                             |
| `dcAgentAddress`             | yes                    | **0 of 12** — never set | attribute only — never an edge input                                             |

| ProviderListRow field | in the withheld input? | populated in the corpus | note                                                                   |
| --------------------- | ---------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `providerID`          | yes                    | 5 of 5                  | registrant identity — two FRNs under one providerID are one registrant |
| `frn`                 | yes                    | 5 of 5                  | the truth key, never itself withheld                                   |
| `holdingCompany`      | **no**                 | **withheld**            | the field under test                                                   |

## Results

| metric                        | withheld (the measurement) | control (parent disclosed) |
| ----------------------------- | -------------------------- | -------------------------- |
| precision                     | N/A                        | 1.000                      |
| recall                        | 0.000                      | 1.000                      |
| F1                            | N/A                        | 1.000                      |
| true-positive pairs           | 0                          | 6                          |
| false-positive pairs          | 0                          | 0                          |
| false-negative pairs          | 6                          | 0                          |
| truth-positive pairs          | 6                          | 6                          |
| predicted-positive pairs      | 0                          | 6                          |
| total registrant pairs scored | 55                         | 55                         |
| input SHA-256                 | `b20909439dcf6bc0…`        | `86f4c23616835425…`        |

F1 is reported as `N/A` for the withheld run rather than `0.000`, and that is not a rounding convention. Precision is undefined when a prediction makes no positive calls at all — there is no denominator — and an F1 built on an undefined component is undefined too. "Recovered nothing because it claimed nothing" and "claimed things and got them all wrong" are different failures with different fixes, and the second one would read `precision 0.000`.

### Same-family pairs, individually

The 6 registrant pairs the withheld field puts together. Every other pair of the 11 registrants (49 of them) is a truth negative, including the identical-name pair.

| registrant A | registrant B | truth family                                         | recovered?                  |
| ------------ | ------------ | ---------------------------------------------------- | --------------------------- |
| 9100000001   | 9100000002   | `holding_company_name:cascade fiber holdings`        | withheld: no · control: yes |
| 9100000001   | 9100000003   | `holding_company_name:cascade fiber holdings`        | withheld: no · control: yes |
| 9100000002   | 9100000003   | `holding_company_name:cascade fiber holdings`        | withheld: no · control: yes |
| 9100000004   | 9100000005   | `holding_company_name:meridian communications group` | withheld: no · control: yes |
| 9100000004   | 9100000010   | `holding_company_name:meridian communications group` | withheld: no · control: yes |
| 9100000005   | 9100000010   | `holding_company_name:meridian communications group` | withheld: no · control: yes |

## What is actually in each artifact

Counted from the two builds, not asserted about them. The withheld build contains no ownership node, no ownership edge and no family row the prediction would score — that is the withholding, verified, and a runtime gate refuses to report a withheld score if any of the three is non-zero. It DOES contain 2 corporate-family rows, from the management-company disclosures the eval does not withhold; they are namespaced separately from ownership families and the prediction skips them. An earlier version of this page claimed no family row could exist here at all, which was wrong on its own artifact.

The family counts are split by what the prediction does with a row, not by relationship name: "scored" is every membership that is not management, so a `subsidiary` or `parent_company` row a future writer emits lands in that count rather than going uncounted. The total is printed alongside both splits so nothing can hide between them.

| what the built artifact contains                                                 | withheld | control |
| -------------------------------------------------------------------------------- | -------- | ------- |
| `holding_company_name` nodes                                                     | 0        | 4       |
| ownership `filer_edge` rows (any non-`same_entity`, non-management relationship) | 0        | 8       |
| `filer_family` rows the prediction scores (any non-management relationship)      | 0        | 8       |
| `filer_family` rows the prediction ignores (management)                          | 2        | 2       |
| `filer_family` rows, total                                                       | 2        | 10      |
| entity-resolution records scored                                                 | 12       | 12      |
| entity-resolution links written                                                  | 0        | 0       |

## Why the withheld run recovers nothing

Nothing else in the build produces an ownership fact. Two mechanisms account for that, and both are deliberate. First, the builder writes a corporate-family row only where an input row names a parent — there is no path from a filing to a family that does not run through a disclosed name. Second, the entity-resolution pass (which ran here, over 12 records) answers a different question: it decides whether two identifiers denote the same legal entity, and it will not merge two records that share no identifier code, no matter how similar their names are. Even if it did merge them, a merge asserts "same company", not "same parent", so it could not populate a family. The corpus exercises that refusal on purpose: two of its filers canonicalize to the byte-identical legal name `american fiber partners` and are NOT the same company. The canonical name is the blocking key, so that pair is proposed as a candidate and scored — and the veto refuses it, which is what a veto is for.

## What would move this number

It is tempting to call the withheld number a floor that any better evidence would lift. That is not what this code does, and an earlier version of this page said it anyway. Two probes settle it.

**Populating the address and contact columns changes nothing.** Fill `hqAddress`, `customerInquiriesTelephone` and `customerInquiriesAddress` identically across all three members of one family in the withheld corpus, then rebuild, re-cluster and re-score: byte-identical result, 0 pairs recovered. Those columns are stored as attributes and nothing on the family path — or on the entity-resolution path, which reads only legal names and identifier codes — ever looks at them. That is a property of the pipeline, not a gap in the corpus.

**Adding an ownership EDGE changes nothing either.** Write inferred `subsidiary` `filer_edge` rows joining those same filers to a parent — the shape a corporate-filing importer is specified to emit — and recall stays 0.000. Corporate-family membership is read from `filer_family`; `filer_edge` is a different table, and no reader on this path crosses from one to the other.

The accurate statement is narrower, and worth stating exactly: **a channel that produces a `filer_family` row moves this number; a channel that produces only a `filer_edge` row does not.** Injecting three ownership `filer_family` rows into the withheld build moves recall from 0.000 to 0.500 at precision 1.000. A standing test holds that open, so "this baseline can be beaten" is re-checked on every run rather than asserted here.

That is also the forward dependency for anyone using this page as a before/after baseline. A later build beats 0.000 only if its new evidence lands as `filer_family` membership rows. An importer that writes ownership edges and stops there re-runs to 0.000 — and it will read as though the evidence didn't help, when in fact nothing read it.

## Metric choice

Precision, recall and F1 are PAIRWISE — over unordered registrant pairs, not over an alignment between predicted and true clusters. A predicted family's id is derived from the canonicalized parent name, so there is no correspondence problem to solve and no alignment step to get wrong; the only well-defined question is whether two registrants are correctly judged together or apart, which pairs answer directly. Empty denominators are reported as `N/A`, never as zero, throughout.

## Reproducibility

SHA-256 of the withheld run's inputs — the exact bytes the builder received: `b20909439dcf6bc0d2b04da43b3b3fb11cdb9ff68313e12d3eeb78a24bacda58`.

SHA-256 of the control run's inputs: `86f4c23616835425615960dabbf22df214fb2001b325e9b0128f9e0abf45f802`.

The corpus is a fixed literal with no sampling and no randomness; the builder and the clustering pass are deterministic; every date the runs depend on is a constant rather than "today". Re-running reproduces both scores and both hashes byte for byte. The test suite regenerates this entire page and compares it to the committed copy, so editing the corpus without republishing fails, rather than quietly leaving the numbers above stale.

## Caveats

This is a synthetic 12-filer corpus, not a run against real FCC Form 499 data — no such corpus ships in this repo with a stable hash to pin to, so the eval buys exactness and reproducibility at the cost of scale. What the withheld number does NOT say is that ownership is hard to recover in general; it says that this build has exactly one way to learn a parent and that way was taken away. Scale is the honest limitation, and it limits confidence rather than the mechanism: a larger corpus of the same shape scores the same, for the reason given above. The control number says nothing about how often real filers report a parent, or report it accurately — only that when they do, this pipeline groups them correctly.
