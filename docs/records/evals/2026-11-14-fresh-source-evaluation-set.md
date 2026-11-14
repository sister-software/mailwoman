---
title: Fresh-source evaluation set for ES, IT, AU and NZ
role: record
audience: maintainer
owner: evaluation
---

# Fresh-source evaluation set for ES, IT, AU and NZ

Status: **frozen, unregistered**. The set exists to clear blocker B1 of
`2026-11-14-release-requirements-v8-proposal.md`: no frozen collection held a `verified_unseen` row for Spain,
Italy, Australia or New Zealand, so the comparative objective was `insufficient_evidence` for every candidate.
No specification registers the set yet. The operator decides whether one does.

## 1. Sources

Each country's training rows in both lineages come from its national address register, plus GLEIF, CORDIS and
synthetic sources. Spain's come from Catastro, the three foral cadastres and CartoCiudad through OpenAddresses.
Italy's come from ANNCSU through OpenAddresses and Overture, Australia's from G-NAF, and New Zealand's from LINZ
through OpenAddresses. A regional or state address register feeds those national registers, so it shares their
upstream and was not used.

The postal operators' own office lists were checked first (observed, 2026-11-14):

| Country | List checked                  | Result                                                                                                                                     |
| ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| ES      | Correos offices               | No national publication. datos.gob.es holds an open request for one (filed 2026-02-04). Madrid and Zaragoza publish city lists only.       |
| IT      | Poste Italiane uffici postali | No open national publication. Poste sells the list as its Points of Interest databank. Turin and Milan publish city lists under CC BY 4.0. |
| AU      | Australia Post outlets        | No open publication on data.gov.au. Australia Post licenses its location and address data.                                                 |
| NZ      | NZ Post PostShops             | The Locator API requires a key NZ Post issues on request and states no reuse grant.                                                        |

Each country's set therefore comes from a national public-body register of facilities or organizations, each a
different publication from every training source:

| Country | Source id               | Publication                                                            | Grant                                                                               | Retrieved copy                                               |
| ------- | ----------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| ES      | `es-sanidad-centros-ap` | Ministerio de Sanidad, Catálogo de Centros de Atención Primaria (2026) | the ministry's aviso legal, authorizing `reproducción … modificación, distribución` | `packages/corpus/data/licenses/es-sanidad-aviso-legal.md`    |
| IT      | `it-miur-scuole`        | MIM, Anagrafe scuole statali 2026/27                                   | IODL 2.0                                                                            | `packages/corpus/data/licenses/it-miur-iodl-2.0.md`          |
| AU      | `au-acnc-register`      | ACNC Registered Charities                                              | CC BY 3.0 AU                                                                        | `packages/corpus/data/licenses/au-acnc-cc-by-3.0-au.md`      |
| NZ      | `nz-charities-register` | Charities Services, Charities Register (OData)                         | CC BY 3.0 NZ                                                                        | `packages/corpus/data/licenses/nz-charities-cc-by-3.0-nz.md` |

Each decision in `license-decisions.json` refuses `train` by decision, so `ingestEligibilityProblems` keeps the
source out of every corpus build, and `heldout/fresh/build.ts` refuses a source whose decision permits training.

## 2. The frozen set

`heldout/fresh/build.run.ts --out /mnt/mw/corpus/heldout` froze `heldout-fresh-sources` version
`b2909f2d18f2b9de`: 8,000 rows, rows sha256 `4d15280d21e255f47683befa6b91cbb682b6941745f4b0f670d4fba14bfb3349`,
seed 2026. A rebuild into a second directory reproduced the version and the rows hash.

Each row is a single-line address (house number, street, postcode, locality, and the state for AU) rendered by
`formatAddressRow` and aligned by `alignRow`, without the facility's or charity's name. A record is kept only where
its street line holds a house number and, for AU and NZ, the address is one street line. Each country draws
2,000 rows across its strata (ES 51 provinces, IT 18 regions, AU 8 states and territories, NZ 10 postcode first
digits): 20 per stratum first, the rest in proportion to supply.

What the selection leaves out (inferred from the refusal tallies in the lineage file): addresses without a house
number (ES 6,909, IT 16,894), unit and level lines (AU 7,288 unplaced numbers), post-office boxes, rural delivery
lines and multi-line addresses. The set measures clean premise addresses only, and a score on it is no evidence
about those forms. IT rows are in capitals because the ministry writes them so.

## 3. Overlap

`overlap.run.ts --match-text` read both lineages in full: v0.8.18-retention-overlay (808 files, 623,020,227 rows)
and v0.7.10-gb-county (965 files, 706,364,298 rows), with the 10.7.0 model card and
`v8.6.3-base-c6-90k-v0818-wof15-s42.yaml` as the candidate. Result: `verified_unseen` 8,000, every other class 0.
No training file matched a row by identity, group or folded text
(`/mnt/mw/corpus/heldout/heldout-fresh-sources.provenance.json`).

Positive control (observed): 300 training texts from v0.8.0's `part-gnaf-au-train` and
`overture-multilocale-native` (100 each for AU, ES and IT), upper-cased with commas removed and a period added,
all came back `known_overlap` from the same audit code. An independent TypeScript fold of those two files'
399,381 distinct AU, ES and IT texts matched none of the 8,000 rows. 751 rows share their first three folded
tokens with some training text.

The text comparison is equality after folding. The audit misses a training row that holds a fresh row's address
inside a longer text, such as the address followed by a country name.

## 4. 10.7.0 on the set

`heldout/per/country.run.ts --dataset`, 10.7.0 int8 (`/mnt/mw/models/arms/fp32master/roots/shipped-i8`), report
`/mnt/mw/models/arms/heldout-fresh-sources-shipped-10.7.0.json`. Every row is its own group, so the bounds are
Clopper–Pearson over rows.

| Country |  Rows | Exact | 95% bound      | Bound at per-side tail 0.00167 |
| ------- | ----: | ----: | -------------- | ------------------------------ |
| AU      | 2,000 | 0.998 | [0.994, 0.999] | [0.992, 1.000]                 |
| ES      | 2,000 | 0.981 | [0.973, 0.986] | [0.970, 0.988]                 |
| IT      | 2,000 | 0.992 | [0.987, 0.995] | [0.984, 0.997]                 |
| NZ      | 2,000 | 0.925 | [0.913, 0.937] | [0.907, 0.942]                 |

The set sits near the ceiling for AU, ES and IT, so a comparison on it detects losses there better than gains.
