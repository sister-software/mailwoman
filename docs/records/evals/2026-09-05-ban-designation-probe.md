# BAN designation probe: does BAN support a per-commune `designated` coverage claim?

**Date:** 2026-09-05. **Task:** evidence-derivation plan Task 10
(`docs/superpowers/plans/2026-08-21-evidence-derivation.md`). **Deliverable:** an answer, not a coverage table.
Nothing here writes `layer_coverage`.

## Verdict: DESIGNATED, per commune — the signal exists upstream and is RECOVERABLE; the current extract does not carry it

`CoverageBasis`'s docstring uses BAN as its `designated` example ("BAN holding every address in a commune"). That is
true of some communes and false of others, and the source says which.

## What was measured

| Quantity                                           | Value                                                                             | Where                                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Streets in `ban/street-centroids-fr.db`            | 2,195,655                                                                         | `street_centroid`, `ban:fr` release 2026-05-18                                                              |
| Distinct communes in the extract (`locality_base`) | 32,539                                                                            | same                                                                                                        |
| Communes in France                                 | ~34,900                                                                           | so a blanket `designated` is false: about 2,400 communes hold no street here                                |
| Columns the upstream per-département CSV carries   | 23, including `certification_commune` and `source_position`                       | header of `adresses-01.csv.gz`, fetched 2026-09-05 from `adresse.data.gouv.fr/data/ban/adresses/latest/csv` |
| Columns the extract keeps                          | `numero`, `rep`, `nom_voie`, `code_postal`, `nom_commune`, `nom_ld`, `lon`, `lat` | `packages/ban/lib/sdk/extract.ts` `REQUIRED_COLUMNS`; `address_point` has no certification column           |

One département read end to end (Ain, `01`, 9,040,886 bytes gzipped):

| Ain, département 01                                              |                            Value |
| ---------------------------------------------------------------- | -------------------------------: |
| Address rows                                                     |                          262,068 |
| Rows with `certification_commune = 1`                            |                  188,499 (71.9%) |
| Communes                                                         |                              391 |
| Communes with EVERY address certified                            |                      178 (45.5%) |
| Communes with some addresses certified                           |                              111 |
| Communes with none certified                                     |                              102 |
| `source_position`: `commune` / `inconnue` / `arcep` / `cadastre` | 212,873 / 43,764 / 3,270 / 2,161 |

## Reading

- Observation: BAN publishes a per-address certification flag, and its distribution is per commune: in Ain, 178
  communes are wholly certified, 102 wholly uncertified, 111 mixed.
- Inference: `certification_commune = 1` marks an address the commune itself asserted through its Base Adresse Locale
  (the upstream field name and the `source_position = commune` co-occurrence support this; the BAN documentation
  states it as the field's meaning). A commune whose every address is certified has DESIGNATED its set; a mixed or
  uncertified commune has not, and its rows are `source_present`.
- Decision the plan asked for: the FR arm CAN carry a per-commune `designated` basis, but only after the extract keeps
  `certification_commune` and the coverage build writes `designated` for wholly certified communes and
  `source_present` for the rest. Until then the FR layer is `source_present` everywhere, and `requireExclusionBasis`
  refuses every FR exclusion — which is the correct answer for a layer that has not yet said which communes are whole.

## Follow-up (not this task)

1. `packages/ban/lib/sdk/extract.ts`: carry `certification_commune` (and `code_insee`, the stable commune key —
   `nom_commune` is a display name) into `address_point`.
2. The street-centroid build writes `layer_coverage` per commune cell: `designated` where every address point in the
   commune is certified, `source_present` otherwise; `basis` never inferred from a share.
3. Re-measure nationally before any FR exclusion ships: Ain's 45.5% wholly certified is one département, not France.

## Not measured

The national share. One département was read because the question was whether the signal exists and varies per
commune, not what the national rate is; the national rate is the follow-up's first number.
