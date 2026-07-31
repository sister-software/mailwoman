# 2026-07-31 — does filer.db recover corporate family without the disclosed parent? (3b task 4)

**Corporate-family membership resolves correctly when the filer discloses its parent, and not at all when it doesn't.** Given the corpus with `holdingCompany` present, `filer.db` puts every one of the 6 same-family registrant pairs in the same family and invents none: precision 1.000, recall 1.000. Given the same corpus with that one field removed, it makes no family call at all — 0 of 6 pairs recovered, recall 0.000, precision and F1 undefined because there were no positive calls to score. Family membership in this pipeline is a disclosed field, transcribed and canonicalized; nothing in the build infers one from anything else.

## The question

A corporate family is a set of operating companies under one parent. `filer.db` builds families from the parent name each filer reports on its Form 499. The open question this eval exists to baseline is whether that membership is recoverable for a filer that reports NOTHING — from names, identifiers, or any other signal already in the pipeline. Today the answer is no, and the number below is what "no" measures as, so that a later build with more evidence has something to beat.

## The two runs

Both runs build a real scratch `filer.db` from the same authored corpus with the same shipped code, and read the prediction the same way. They differ in one field.

- **withheld** — `holdingCompany` cleared on every Form 499 row and every provider-list row before the builder sees it. The measurement.
- **control** — the identical corpus, that field intact. The check on the harness.

The control run is not an achievement and should not be read as one. A pipeline whose entire family mechanism is "copy the parent name the filer wrote down, canonicalize it, and group by the result" is supposed to score 1.000 when handed that name. Its job here is narrower and more important: it proves this harness reads a table the truth can actually reach. Without it, the withheld run's zero is unfalsifiable — an eval pointed at the wrong table reports zero too, and reports it just as confidently with the answer sitting in the artifact. The two runs differ in exactly one field, and the input hashes below differ accordingly.

### What counts as a prediction

Two registrants are predicted to be the same family iff the built `filer.db` places them in a common family as of 2026-06-01, read through the same corporate-family reader a product caller would use. Membership rows that exist only because two filers named the same MANAGEMENT company are excluded from both the prediction and the truth: management is operational control, not ownership; that field is not withheld here; and letting it answer would mean a field this eval hands over deciding a question about the field it holds back. The corpus includes two filers reporting the same manager so that exclusion has something to do.

### What counts as a registrant

The unit scored is the registrant, not the FRN. One operator can hold several FRN registrations — the corpus has one that holds two, joined by a shared provider id — and a parent disclosed on one registration is a fact about the company, not about that registration. Scoring FRNs individually would have let the truth partition put a single legal entity in two different families at once.

## Corpus

12 Form 499 filers folded into 11 registrants, authored rather than sampled so every truth fact is auditable here instead of trusted from an external source. Two multi-member families whose members spell the parent name inconsistently; four standalone filers; a pair of unrelated companies with identical canonical names; one registrant holding two FRNs where only the second discloses the parent.

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

Every field the builder receives in the withheld run, and how much of it the corpus actually fills in. The empty columns matter: they are the corroboration channels a future version would have to lean on, and this corpus does not exercise them.

| Form499Row field             | in the withheld input? | populated in the corpus | note                                                                     |
| ---------------------------- | ---------------------- | ----------------------- | ------------------------------------------------------------------------ |
| `form499ID`                  | yes                    | 12 of 12                |                                                                          |
| `frn`                        | yes                    | 12 of 12                | the truth key, never itself withheld                                     |
| `lastFiledAt`                | yes                    | 12 of 12                |                                                                          |
| `usfContributor`             | yes                    | **0 of 12** — never set |                                                                          |
| `legalNameOfCarrier`         | yes                    | 12 of 12                | the entity-resolution pass's blocking key and score input                |
| `doingBusinessAs`            | yes                    | 2 of 12                 |                                                                          |
| `principalCommType`          | yes                    | 12 of 12                |                                                                          |
| `holdingCompany`             | **no**                 | **withheld**            | the field under test                                                     |
| `managementCompany`          | yes                    | 2 of 12                 | control, not ownership — kept in the input, excluded from the prediction |
| `hqAddress`                  | yes                    | **0 of 12** — never set | a corroboration channel the corpus does not populate                     |
| `customerInquiriesTelephone` | yes                    | **0 of 12** — never set | a corroboration channel the corpus does not populate                     |
| `customerInquiriesAddress`   | yes                    | **0 of 12** — never set | a corroboration channel the corpus does not populate                     |
| `dcAgentDisplayName`         | yes                    | **0 of 12** — never set | attribute only — never an edge input (shared-agent doctrine)             |
| `dcAgentOrganizationName`    | yes                    | **0 of 12** — never set | attribute only — never an edge input                                     |
| `dcAgentTelephone`           | yes                    | **0 of 12** — never set | attribute only — never an edge input                                     |
| `dcAgentEmailAddress`        | yes                    | **0 of 12** — never set | attribute only — never an edge input                                     |
| `dcAgentAddress`             | yes                    | **0 of 12** — never set | attribute only — never an edge input                                     |

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

Counted from the two builds, not asserted about them. The withheld build contains no ownership node, no ownership edge and no ownership family row — that is the withholding, verified. It DOES contain 2 corporate-family rows, from the management-company disclosures the eval does not withhold; they are namespaced separately from ownership families and the prediction skips them. An earlier version of this page claimed no family row could exist here at all, which was wrong on its own artifact.

| what the built artifact contains | withheld | control |
| -------------------------------- | -------- | ------- |
| `holding_company_name` nodes     | 0        | 4       |
| `holding_company` edges          | 0        | 8       |
| `filer_family` rows — ownership  | 0        | 8       |
| `filer_family` rows — management | 2        | 2       |
| entity-resolution records scored | 12       | 12      |
| entity-resolution links written  | 0        | 0       |

## Why the withheld run recovers nothing

Nothing else in the build produces an ownership fact. Two mechanisms account for that, and both are deliberate. First, the builder writes a corporate-family row only where an input row names a parent — there is no path from a filing to a family that does not run through a disclosed name. Second, the entity-resolution pass (which ran here, over 12 records) answers a different question: it decides whether two identifiers denote the same legal entity, and it will not merge two records that share no identifier code, no matter how similar their names are. Even if it did merge them, a merge asserts "same company", not "same parent", so it could not populate a family. The corpus exercises that refusal on purpose: two of its filers canonicalize to the byte-identical legal name `american fiber partners` and are NOT the same company. The canonical name is the blocking key, so that pair is proposed as a candidate and scored — and the veto refuses it, which is what a veto is for.

So the withheld number is a floor on today's evidence, not a bound on the problem. Any channel that actually correlates with ownership — a shared headquarters address, a shared officer, an external corporate filing that names a parent — would show up here as recall above zero. None is wired in.

## Metric choice

Precision, recall and F1 are PAIRWISE — over unordered registrant pairs, not over an alignment between predicted and true clusters. A predicted family's id is derived from the canonicalized parent name, so there is no correspondence problem to solve and no alignment step to get wrong; the only well-defined question is whether two registrants are correctly judged together or apart, which pairs answer directly. Empty denominators are reported as `N/A`, never as zero, throughout.

## Reproducibility

SHA-256 of the withheld run's inputs — the exact bytes the builder received: `b20909439dcf6bc0d2b04da43b3b3fb11cdb9ff68313e12d3eeb78a24bacda58`.

SHA-256 of the control run's inputs: `86f4c23616835425615960dabbf22df214fb2001b325e9b0128f9e0abf45f802`.

The corpus is a fixed literal with no sampling and no randomness; the builder and the clustering pass are deterministic; every date the runs depend on is a constant rather than "today". Re-running reproduces both scores and both hashes byte for byte. The test suite regenerates this entire page and compares it to the committed copy, so editing the corpus without republishing fails, rather than quietly leaving the numbers above stale.

## Caveats

This is a synthetic 12-filer corpus, not a run against real FCC Form 499 data — no such corpus ships in this repo with a stable hash to pin to, so the eval buys exactness and reproducibility at the cost of scale. Read the withheld number as a floor rather than a limit: it says that on today's evidence channels nothing recovers family membership, not that nothing could. A corpus with populated headquarters addresses or contact details would be a genuinely different experiment, and the right one to run once those channels carry data. The control number says nothing about how often real filers report a parent, or report it accurately — only that when they do, this pipeline groups them correctly.
