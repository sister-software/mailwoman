# 2026-07-31 — does filer.db recover corporate family without the disclosed parent?

**`filer.db` recovers corporate-family membership when a filer discloses its parent, and recovers none when it does not.** With `holdingCompany` present, the build places all 6 same-family registrant pairs in the same family and adds no false pairs: precision 1.000, recall 1.000. With that one field removed from the same corpus, the build makes no family predictions. It recovers 0 of 6 pairs for a recall of 0.000, and precision and F1 are undefined because there are no positive predictions to score. This pipeline takes family membership from the disclosed parent name after canonicalizing it, and nothing in the build infers membership from other evidence.

## The question

A corporate family is a set of operating companies under one parent. `filer.db` builds families from the parent name that a filer discloses on its Form 499 or on the broadband provider list, and both sources contribute rows to the control build below. This eval sets a baseline for whether membership can be recovered for a filer that discloses no parent, using names, identifiers or any other signal already in the pipeline. Today it cannot, and the withheld score below records that result so that a later build with more evidence has a number to beat.

## The two runs

Both runs build a scratch `filer.db` from the same authored corpus with the same shipped code, and both read the prediction the same way. They differ in one field.

- **withheld**: `holdingCompany` is cleared on every Form 499 row and every provider-list row before the builder reads them. This run is the measurement.
- **control**: the corpus keeps that field. This run checks the harness.

The control score is expected rather than impressive. A pipeline that groups filers by the canonicalized parent name they reported should score 1.000 when it is given that name. The control run shows that the harness reads a table the truth can reach. Without it, the withheld score of zero could not be falsified, because an eval that reads the wrong table also reports zero. The two runs differ in exactly one field, and their input hashes differ accordingly.

### What counts as a prediction

Two registrants are predicted to share a family when the built `filer.db` places them in a common family as of 2026-06-01. The eval reads each membership with the shipped corporate-family reader that product callers use. That reader answers for one node at a time, and a registrant can own several nodes (its FRN registrations and its provider ID), so the eval takes the union of the families across those nodes. The union is the eval's own step, and it is why a parent disclosed on only one of a registrant's two filings still counts.

Memberships that exist only because two filers reported the same management company are excluded from both the prediction and the truth. Management is operational control rather than ownership, and the eval does not withhold that field. Counting it would let a field the eval provides decide a question about the field the eval withholds. The corpus includes two filers that report the same manager so that the exclusion is exercised.

### What counts as a registrant

The eval scores registrants rather than FRNs. One operator can hold several FRN registrations, and the corpus has one registrant that holds two, joined by a shared provider ID. A parent disclosed on one registration describes the whole company. Scoring FRNs separately would let the truth partition put one legal entity in two families at once.

Treating a shared provider ID as proof of one registrant is a modelling choice. Real provider-list rows that share a provider ID have been observed reporting different parents, which would mean the fold joins companies that should stay apart. That failure would be visible here. Folding two registrants from different families puts a truth-negative pair inside one truth group, the control run cannot recover that pair, control recall falls below 1.000, and the test that asserts a perfect control fails.

## Corpus

The corpus has 12 Form 499 filers folded into 11 registrants. It is authored rather than sampled, so every truth fact can be audited on this page instead of trusted from an external source. It contains the following filers.

- Two multi-member families whose members spell the parent name inconsistently.
- Four standalone filers.
- Two unrelated companies with identical canonical names.
- One registrant that holds two FRNs, where only the second filing discloses the parent.
- One filer that discloses no parent but reports the same management company as a member of the first family. The prediction must not treat that as ownership.

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

The tables below list every field the builder receives in the withheld run and how much of each field the corpus fills in. Filling in the empty fields would not change the result, because nothing on the family path reads them (see "What would move this number" below). They are listed so that the corpus's sparsity is not mistaken for the reason the withheld run scores zero.

| Form499Row field             | in the withheld input? | populated in the corpus | note                                                                                                                                                                               |
| ---------------------------- | ---------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `form499ID`                  | yes                    | 12 of 12                |                                                                                                                                                                                    |
| `frn`                        | yes                    | 12 of 12                | The truth key. It is never withheld.                                                                                                                                               |
| `lastFiledAt`                | yes                    | 12 of 12                |                                                                                                                                                                                    |
| `usfContributor`             | yes                    | **0 of 12** (never set) |                                                                                                                                                                                    |
| `legalNameOfCarrier`         | yes                    | 12 of 12                | The entity-resolution pass uses it as the blocking key and as a score input.                                                                                                       |
| `doingBusinessAs`            | yes                    | 2 of 12                 |                                                                                                                                                                                    |
| `principalCommType`          | yes                    | 12 of 12                |                                                                                                                                                                                    |
| `holdingCompany`             | **no**                 | **withheld**            | The field under test.                                                                                                                                                              |
| `managementCompany`          | yes                    | 2 of 12                 | Records control rather than ownership. It stays in the input and is excluded from the prediction.                                                                                  |
| `hqAddress`                  | yes                    | **0 of 12** (never set) | Stored as an attribute. Neither the family path nor the entity-resolution path reads it.                                                                                           |
| `customerInquiriesTelephone` | yes                    | **0 of 12** (never set) | Stored as an attribute. Neither the family path nor the entity-resolution path reads it.                                                                                           |
| `customerInquiriesAddress`   | yes                    | **0 of 12** (never set) | Stored as an attribute. Neither the family path nor the entity-resolution path reads it.                                                                                           |
| `dcAgentDisplayName`         | yes                    | **0 of 12** (never set) | Stored as an attribute. It never becomes an edge input.                                                                                                                            |
| `dcAgentOrganizationName`    | yes                    | **0 of 12** (never set) | Stored as an attribute. It never becomes an edge input.                                                                                                                            |
| `dcAgentTelephone`           | yes                    | **0 of 12** (never set) | Stored as an attribute. It never becomes an edge input.                                                                                                                            |
| `dcAgentEmailAddress`        | yes                    | **0 of 12** (never set) | Stored as an attribute. It never becomes an edge input.                                                                                                                            |
| `dcAgentAddress`             | yes                    | **0 of 12** (never set) | Stored as an attribute. It never becomes an edge input.                                                                                                                            |
| `lifecycle`                  | yes                    | **0 of 12** (never set) | Workbook-only. It holds the FCC's cessation date and successor filer, which close `valid_to` on a real build. The synthetic corpus does not set it, so this eval does not read it. |
| `operatingStates`            | yes                    | **0 of 12** (never set) | Workbook-only registered footprint. It is stored as an attribute, and edges never read it.                                                                                         |

| ProviderListRow field | in the withheld input? | populated in the corpus | note                                                                    |
| --------------------- | ---------------------- | ----------------------- | ----------------------------------------------------------------------- |
| `providerID`          | yes                    | 5 of 5                  | Registrant identity. Two FRNs under one provider ID are one registrant. |
| `frn`                 | yes                    | 5 of 5                  | The truth key. It is never withheld.                                    |
| `holdingCompany`      | **no**                 | **withheld**            | The field under test.                                                   |

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

The withheld run reports F1 as `N/A` rather than `0.000` on purpose. Precision is undefined when a prediction makes no positive calls, because its denominator is zero, and an F1 built on an undefined precision is also undefined. Recovering nothing because nothing was predicted is a different failure from predicting pairs and getting them all wrong, which would show `precision 0.000`.

### Same-family pairs, individually

The table lists the 6 registrant pairs that the withheld field puts together. The other 49 pairs of the 11 registrants are truth negatives, including the pair with identical names.

| registrant A | registrant B | truth family                                         | recovered?                  |
| ------------ | ------------ | ---------------------------------------------------- | --------------------------- |
| 9100000001   | 9100000002   | `holding_company_name:cascade fiber holdings`        | withheld: no · control: yes |
| 9100000001   | 9100000003   | `holding_company_name:cascade fiber holdings`        | withheld: no · control: yes |
| 9100000002   | 9100000003   | `holding_company_name:cascade fiber holdings`        | withheld: no · control: yes |
| 9100000004   | 9100000005   | `holding_company_name:meridian communications group` | withheld: no · control: yes |
| 9100000004   | 9100000010   | `holding_company_name:meridian communications group` | withheld: no · control: yes |
| 9100000005   | 9100000010   | `holding_company_name:meridian communications group` | withheld: no · control: yes |

## What is in each artifact

These counts come from the two builds rather than from assertions about them. The withheld build has zero ownership nodes, ownership edges, scored family rows, and family rows with a relationship the eval cannot classify. Those four zero counts confirm the withholding, and a runtime check refuses to report a withheld score if any of them is non-zero. The build does contain 2 corporate-family rows from the management-company disclosures, which the eval does not withhold. Those rows use a separate namespace from ownership families, and the prediction skips them.

The family counts are split by what the prediction does with each row rather than by relationship name, and the three buckets partition the total. The scored bucket holds every membership whose relationship asserts ownership, so a `subsidiary` or `parent_company` row from a future writer is counted there. The second bucket holds the relationships the eval recognizes and deliberately does not score: `management_company` and `same_entity`. The third bucket holds any other relationship string, which the shipped writers never produce, and the check refuses to report a score when that bucket is not empty. The table prints the total next to the three buckets, so every row is accounted for.

| what the built artifact contains                                                | withheld | control |
| ------------------------------------------------------------------------------- | -------- | ------- |
| `holding_company_name` nodes                                                    | 0        | 4       |
| ownership `filer_edge` rows (relationship asserts ownership)                    | 0        | 8       |
| `filer_family` rows the prediction scores (relationship asserts ownership)      | 0        | 8       |
| `filer_family` rows the prediction ignores (recognized, but not ownership)      | 2        | 2       |
| `filer_family` rows with an unrecognized relationship (the check refuses these) | 0        | 0       |
| `filer_family` rows, total                                                      | 2        | 10      |
| entity-resolution records scored                                                | 12       | 12      |
| entity-resolution links written                                                 | 0        | 0       |

## Why the withheld run recovers nothing

No other part of the build produces an ownership fact, and two deliberate design choices keep it that way. First, the builder writes a corporate-family row only when an input row discloses a parent, so every path from a filing to a family runs through a disclosed name. Second, the entity-resolution pass, which ran here over 12 records, answers a different question. It decides whether two identifiers denote the same legal entity, and it merges two records only when they share an identifier code, however similar their names are. A merge would assert that two records are the same company rather than that they share a parent, so even a merge could not populate a family. The corpus tests that refusal on purpose. Two of its filers canonicalize to the identical legal name `american fiber partners` but are different companies. The canonical name is the blocking key, so the pair is proposed and scored, and the identifier veto rejects it.

## What would move this number

Better evidence would not lift the withheld score in this code, and two probes show why.

**Populating the address and contact fields changes nothing.** Filling `hqAddress`, `customerInquiriesTelephone` and `customerInquiriesAddress` identically across all three members of one family in the withheld corpus, then rebuilding, re-clustering and re-scoring, gives a byte-identical result with 0 pairs recovered. Those fields are stored as attributes. Neither the family path nor the entity-resolution path reads them, because entity resolution reads only legal names and identifier codes. The result comes from the pipeline's design rather than from gaps in the corpus.

**Adding an ownership edge changes nothing either.** Writing inferred `subsidiary` `filer_edge` rows that join the same filers to a parent, in the shape a corporate-filing importer is specified to emit, leaves recall at 0.000. Corporate-family membership is read from `filer_family` alone. The family readers query `filer_edge` only to recover the raw company name behind a canonicalized family ID, and never to decide who belongs to a family, which is what this eval scores.

**A channel that writes a `filer_family` row moves this number, and a channel that writes only a `filer_edge` row does not.** Injecting three ownership `filer_family` rows into the withheld build raises recall from 0.000 to 0.500 at precision 1.000. A standing test keeps that probe running, so the claim that this baseline can be beaten is checked on every run.

Anyone using this page as a before-and-after baseline depends on that distinction. A later build scores above 0.000 only if its new evidence lands as `filer_family` membership rows. An importer that writes ownership edges and stops there will score 0.000 again, which would look as if the evidence did not help when in fact nothing read it.

## Metric choice

Precision, recall and F1 are pairwise. They count unordered registrant pairs rather than aligning predicted clusters with true ones. A predicted family's ID is derived from the canonicalized parent name, so there is no correspondence problem and no alignment step to get wrong. The only well-defined question is whether two registrants are correctly placed together or apart, and pairs answer it directly. An empty denominator is reported as `N/A`, never as zero.

## Reproducibility

The SHA-256 of the withheld run's inputs, which are the exact bytes the builder received, is `b20909439dcf6bc0d2b04da43b3b3fb11cdb9ff68313e12d3eeb78a24bacda58`.

The SHA-256 of the control run's inputs is `86f4c23616835425615960dabbf22df214fb2001b325e9b0128f9e0abf45f802`.

The corpus is a fixed literal without sampling or randomness, the builder and the clustering pass are deterministic, and every date the runs depend on is a constant. Re-running the eval reproduces both scores and both hashes byte for byte. The test suite regenerates this page and compares it with the committed copy, so a corpus change that is not republished fails the test.

## Caveats

This corpus is a synthetic set of 12 filers rather than real FCC Form 499 data, because the repository ships no real corpus with a stable hash to pin. The eval gains exactness and reproducibility at the cost of scale. The withheld score does not show that ownership is hard to recover in general. It shows that this build has one way to learn a parent, and that way was removed. Scale limits confidence but not the mechanism, because a larger corpus of the same shape would score the same for the reason given above. The control score does not measure what share of real filers report a parent or how accurately they report it. It shows only that this pipeline groups filers correctly when they do.
