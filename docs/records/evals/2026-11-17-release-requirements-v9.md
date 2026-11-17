---
title: Release requirements v9, the county relabel and a geocode check
role: record
audience: maintainer
owner: evaluation
---

# Release requirements v9, the county relabel and a geocode check

Status: **registered**. The operator decided four things on 2026-11-17, and this record applies them.
`release/current-spec.ts` names
`packages/mailwoman/tools/eval-harness/release/specs/release-requirements.v9.json`. Version 9 keeps every v8
threshold, statistic, provenance rule and identity except `identities.dataset`, and changes what section 4 lists.

## 1. Restamp

Every schema 1 collection under `/mnt/mw/corpus/heldout/` was restamped on 2026-11-17 after lane AD finished
grading seed 43, with `heldout/dataset/restamp.run.ts`: the v0.8.18 v2 development set first, then its
confirmation set with `--excludes`, then the rest. A confirmation set takes its development set's new version
in `sampling.excludes`. No rows file changed, and each was checked against its recorded sha256 first. The r2 probe
sets were restamped earlier by lane AE.

| Manifest                                                         | Old version        | New version        | Excludes (new)                                |
| ---------------------------------------------------------------- | ------------------ | ------------------ | --------------------------------------------- |
| `heldout-dev-v0.8.18.v2.json`                                    | `00c4698a7fdc6edf` | `6b88e2ccde68d9ac` |                                               |
| `heldout-confirm-v0.8.18.v2.json`                                | `8606834b12100089` | `35b165ca2b6c019e` | `heldout-dev-v0.8.18@6b88e2ccde68d9ac`        |
| `heldout-dev-v0.7.10-gb-county.json`                             | `4eba39056032f5a1` | `f9c63d8e39975b52` |                                               |
| `heldout-dev-v0.8.0.json`                                        | `fd97193ee85dfb4c` | `2be3dba5413e38eb` |                                               |
| `heldout-confirm-v0.8.0.json`                                    | `bf64ad9a0cd8194a` | `d6b33a9546fd3a5e` | `heldout-dev-v0.8.0@2be3dba5413e38eb`         |
| `heldout-dev-v0.8.1.json`                                        | `911fcdc98a302a62` | `59b245316abb9ef5` |                                               |
| `heldout-confirm-v0.8.1.json`                                    | `839fc18a197b0895` | `66426f6088702109` | `heldout-dev-v0.8.1@59b245316abb9ef5`         |
| `heldout-dev-v0.8.2.json`                                        | `ba28446900e26c6f` | `7429ba38e2c85f37` |                                               |
| `heldout-confirm-v0.8.2.json`                                    | `22422da70e135f62` | `fd06306686a7d94a` | `heldout-dev-v0.8.2@7429ba38e2c85f37`         |
| `heldout-dev-v0.8.10.json`                                       | `bf53fbd0ca61cb27` | `36b549a668c0a5a8` |                                               |
| `heldout-dev-v0.8.12.json`                                       | `1f3bac0200b610fd` | `ceacd89a65cd5513` |                                               |
| `heldout-dev-v0.8.18.json` (superseded draw)                     | `187e8ab06b37351c` | `86d3e72a8b321a16` |                                               |
| `heldout-confirm-v0.8.18.json` (superseded draw)                 | `35ba77d61aa40921` | `25dbaf36993905f5` | `heldout-dev-v0.8.18@86d3e72a8b321a16`        |
| `heldout-dev-v0.8.19-probes.json` (r1)                           | `35918b253d662895` | `94f30c04020344b0` |                                               |
| `heldout-confirm-v0.8.19-probes.json` (r1)                       | `d9e5eac8fe145dc6` | `ee4280f2f2011014` | `heldout-dev-v0.8.19-probes@94f30c04020344b0` |
| `heldout-fresh-sources.json`                                     | `b2909f2d18f2b9de` | `a6b25629448942a4` |                                               |
| `thin-system-v1.json`                                            | `cd08d7e81a020a31` | `513c9e014c0892c0` |                                               |
| `superseded/thin-system-v1-bd61b5a41b17cbc4/thin-system-v1.json` | `bd61b5a41b17cbc4` | `32f31dcccf8cdb11` |                                               |
| `osm-suites/osm-district-before-city-v1.json`                    | `6fd514099294fe70` | `72a3fe2cfe4944d7` |                                               |
| `osm-suites/osm-district-before-city-v2.json`                    | `b266a139621860c8` | `b35ccb76ca4ecc6d` |                                               |
| `osm-suites/osm-place-without-street-v1.json`                    | `474199b22ae58862` | `2f68aa0f058b2160` |                                               |
| `osm-suites/osm-place-without-street-v2.json`                    | `43f8ebc0906298b4` | `2256eb7479336cfb` |                                               |
| `osm-suites/osm-region-after-locality-v1.json`                   | `017bdfe2456ff733` | `84239a4fb1e7d28f` |                                               |
| `osm-suites/osm-region-after-locality-v2.json`                   | `cec3240491a4505f` | `215e559f00952253` |                                               |
| `osm-suites/osm-units-v1.json`                                   | `cb206848049b3f87` | `69fe1dd61c99f719` |                                               |
| `osm-suites/osm-units-v2.json`                                   | `3ae9bba9143d6b5c` | `f555ca20c0094ae6` |                                               |
| `osm-suites/osm-venue-with-address-v1.json`                      | `7378b7684dc1dd15` | `88d9e3429650dd18` |                                               |
| `osm-suites/osm-venue-with-address-v2.json`                      | `1d3672098c29e20d` | `ba92f85720602602` |                                               |
| `osm-suites/photon-district-before-city-v1.json`                 | `70511778f3a6a42a` | `e24a91ae29277dc2` |                                               |
| `osm-suites/photon-place-without-street-v1.json`                 | `0cc52b05322859a9` | `d52b2eadac74eff8` |                                               |
| `osm-suites/photon-plain-address-v1.json`                        | `7e3ebfef8140f507` | `0f637240d90afd07` |                                               |
| `osm-suites/photon-region-after-locality-v1.json`                | `5088ae94022c6175` | `d8e1100c8894dbe1` |                                               |
| `osm-suites/photon-venue-with-address-v1.json`                   | `3eb592cae7b6103e` | `e8e865a6afb91eb1` |                                               |

Readers checked afterwards: `country.run.ts` and `evaluate.run.ts` on every v9 collection (section 5),
`dataset/compare.run.ts` from the restamped v2 development set to v3 (23 rows with changed annotations, and 0
rows added, removed or regrouped), `dataset/evaluation-groups.run.ts`, which regenerated
`packages/corpus/data/holdout/evaluation-groups.v0.8.19.json` from the four v9 collections (100,486 groups, the
same list, with new versions and manifest sha256s), and `dataset/coverage/register.run.ts`, which regenerated
`evaluation-coverage.mdx` for development v3 (header lines only). The battery reads only the osm-suites rows
files, whose bytes the restamp left unchanged.

## 2. The county decision

A county written in the town position is `subregion`. `heldout/dataset/relabel.run.ts` applies the revision
`county-in-locality-slot-subregion` (`heldout/dataset/relabel.ts`): every expected `locality` span whose text
ends or starts with its row country's designator in the codex `county-designators` table (US, CA and IE) becomes
`subregion`, and every other span keeps its tag. The tool writes a new manifest beside the source under the source's datasetID. Its
`revision` field records the source's version under the current rule and its rows sha256, the rule, and each
changed row's spans before and after. The v2 manifests and rows files stay byte for byte as they were.

| New manifest under `/mnt/mw/corpus/heldout/` | Source (current-rule version)                           | New version        | Rows changed | Rows sha256                                                        |
| -------------------------------------------- | ------------------------------------------------------- | ------------------ | -----------: | ------------------------------------------------------------------ |
| `heldout-dev-v0.8.18.v3.json`                | `heldout-dev-v0.8.18.v2.json` `6b88e2ccde68d9ac`        | `adeeef40d7d81a7c` |           23 | `b904f768bbd57deabab683ad12dcff7dd1c86dee429762ddf723b93ac6faab53` |
| `heldout-confirm-v0.8.18.v3.json`            | `heldout-confirm-v0.8.18.v2.json` `35b165ca2b6c019e`    | `681959088a46e5c6` |           22 | `ba24616aed70776f6bc0ed9e4ed17c2574ae2dcc589e32ecbb6c47743244294f` |
| `heldout-dev-v0.8.19-probes-r2.v2.json`      | `heldout-dev-v0.8.19-probes-r2.json` `c6ff3a6a1bc8aab7` | `dd560a53b897dbca` |            1 | `7e6383e4768978598e77373124383d5d43b8b2cd49a15b614396f2919bcc920a` |

The confirmation v3 set's `sampling.excludes` records `heldout-dev-v0.8.18@6b88e2ccde68d9ac`, the development set
it was drawn without, restamped. The groups of v2 and v3 are equal. The confirmation probe set held no row with a
county designator in the locality slot, so it is unchanged.

The search read every tag of every row of the four collections for a value with a designator of its country. It
found the 43 US rows lane Y listed plus three more: 2 IE `gleif-lei` rows writing `co Dublin` in the locality slot, and
1 development probe row. One US `street` and one US `venue` hold a designator and stay as they are. CA holds none.

Changed rows. Development, `heldout-dev-v0.8.18` (each `locality=X` became `subregion=X`):

| Row id (source:source_id)                                                                  | Span              |
| ------------------------------------------------------------------------------------------ | ----------------- |
| `gleif-lei:gleif-lei-0ee0330b18fa`                                                         | `co Dublin`       |
| `gleif-lei:gleif-lei-0ee0330b18fa+drop-commas`                                             | `co Dublin`       |
| `usgov-nad:usgov-nad-c9c6818f-7deb-4b04-b3e5-6a59642b9592-6ac04261057d+drop-commas`        | `CARTER COUNTY`   |
| `usgov-nad:usgov-nad-d46e8827-caa2-4b52-8a75-58cf2bffcf65-ad1959669b20+case-lower`         | `carter county`   |
| `usgov-nad:usgov-nad-7fab071f-617b-43d3-8e2b-13312bc86294-ae89907d8616+double-space`       | `CARTER  COUNTY`  |
| `usgov-nad:usgov-nad-1bfeb5d4-babd-437a-9691-b8b1d0186431-74def8ae308c+state-expand`       | `CARTER COUNTY`   |
| `usgov-nad:usgov-nad-d1c94d86-2a82-43fa-8cf1-b134bd777c1e-20ac3c613d87`                    | `CARTER COUNTY`   |
| `usgov-nad:usgov-nad-692e65ce-758a-4f15-a9d4-5b9f73aa9525-5e1c5ae276ac+state-expand`       | `CARTER COUNTY`   |
| `usgov-nad:usgov-nad-67d5eb26-cdd6-4832-a704-ad92aab1c6d4-ac4ba7d67d93+case-upper`         | `CARTER COUNTY`   |
| `usgov-nad:usgov-nad-8f679c3b-85ab-46e0-9504-b41c7cf5cb0b-ad5017508dd5+directional-expand` | `JOHNSTON COUNTY` |
| `usgov-nad:usgov-nad-8d39f883-7815-45fb-8dd1-e40b496003bd-706ff6590b98+drop-commas`        | `JOHNSTON COUNTY` |
| `usgov-nad:usgov-nad-5b15cd63-0319-4aa4-bdb5-a936b18042f5-8854487be927+case-lower`         | `carter county`   |
| `usgov-nad:usgov-nad-fc9f50ea-32aa-4eb1-8bfa-b01e7d46a8e8-f13c0c19838a+double-space`       | `CARTER  COUNTY`  |
| `usgov-nad:usgov-nad-d6fb27f9-2b58-4159-a0f9-8ad261b9dc95-da28595b3e75`                    | `CARTER COUNTY`   |
| `usgov-nad:usgov-nad-528532ac-4740-4fe0-a476-c3ca2e18570d-2050d3818684+case-upper`         | `CARTER COUNTY`   |
| `usgov-nad:usgov-nad-950f8078-f82b-4cb7-b5df-c4c047d51c14-026204bbb8ac+state-expand`       | `CARTER COUNTY`   |
| `usgov-nad:usgov-nad-8bdccbe6-19e9-4210-9a45-45a42d855bbf-412cef4aec91+case-lower`         | `carter county`   |
| `usgov-nad:usgov-nad-0c151b21-9be6-4d4e-a818-306dbefa0760-2ce230005389+case-lower`         | `carter county`   |
| `usgov-nad:usgov-nad-c87aa83f-cd57-42ec-82a2-d0038ca7e558-28d80f6ace5e+case-upper`         | `CARTER COUNTY`   |
| `usgov-nad:usgov-nad-997f931e-86eb-4016-b44a-e5e53dcddd69-ee5719b201f9+case-upper`         | `CARTER COUNTY`   |
| `usgov-nad:usgov-nad-bfd13c1d-97da-4a48-9eea-7581dcdfb7fc-34a1a3725998+case-upper`         | `CARTER COUNTY`   |
| `usgov-nad:usgov-nad-3f8fd110-77bc-447a-b65b-ea83e03ff267-d340d398acd4`                    | `JOHNSTON COUNTY` |
| `usgov-nad:usgov-nad-46021e72-1baa-41cf-9744-6685cbe1261e-b63d551aff1b+state-expand`       | `CARTER COUNTY`   |

Confirmation, `heldout-confirm-v0.8.18`:

| Row id (source:source_id)                                                                           | Span               |
| --------------------------------------------------------------------------------------------------- | ------------------ |
| `usgov-nad:usgov-nad-7b36de7c-c40e-4684-92bc-4d988f61e88c-123932cc1d59+drop-commas`                 | `JOHNSTON COUNTY`  |
| `usgov-nad:usgov-nad-652e7da7-a74c-4c40-bc79-7d9c16919639-2e0f29b46adb+double-space`                | `CARTER  COUNTY`   |
| `usgov-nad:usgov-nad-13f3198d-dd85-4f22-9b6f-e7fb15f74af7-e2c12567ebf0+state-expand`                | `JOHNSTON COUNTY`  |
| `usgov-nad:usgov-nad-ada42432-e6e8-40fd-ba59-b12d0606f3e0-dc92b7a3b931+double-space`                | `CARTER  COUNTY`   |
| `usgov-nad:usgov-nad-8231acdb-5b7f-4e52-a865-3dff27e891c6-5c2affb816bc+case-lower`                  | `carter county`    |
| `usgov-nad:usgov-nad-8137d390-81ef-4026-8f42-dc875d07c9f0-aa09bda76c43+case-lower`                  | `carter county`    |
| `usgov-nad:usgov-nad-4a26273c-c590-4c70-be5a-d80e1685fa02-19ce899540d1+case-upper`                  | `JOHNSTON COUNTY`  |
| `usgov-nad:usgov-nad-cbff2e37-c933-40aa-9562-f1d116550900-3139e26144f9+directional-abbreviate`      | `JOHNSTON COUNTY`  |
| `usgov-nad:usgov-nad-5db64cbd-de30-44dd-b6d0-75d083ac3734-9d6269b061d0+double-space`                | `JOHNSTON  COUNTY` |
| `usgov-nad:usgov-nad-9ee7366a-7efb-4f3e-b015-79a022beb2c8-783e0e0c2dff+case-upper`                  | `CARTER COUNTY`    |
| `usgov-nad:usgov-nad-619ca136-0488-49fa-b067-542fbb48d1c4-fd958c4da6f4+us-street-suffix-abbreviate` | `JOHNSTON COUNTY`  |
| `usgov-nad:usgov-nad-77633aba-54fe-46e3-9292-cf51c6070757-9b954c420f89+drop-commas`                 | `JOHNSTON COUNTY`  |
| `usgov-nad:usgov-nad-2caffc5b-c023-49a1-b3b3-b3a6c80afa85-9f815957d6bb+case-lower`                  | `carter county`    |
| `usgov-nad:usgov-nad-0b875ed6-0463-451a-85ed-e41404a9159b-8f7170b291a1+state-expand`                | `CARTER COUNTY`    |
| `usgov-nad:usgov-nad-9d07076e-062d-4a4b-85b8-3ab0284882e8-631a33046f10+drop-commas`                 | `CARTER COUNTY`    |
| `usgov-nad:usgov-nad-e5383f45-b10f-4be6-a06c-fbf57ea1f84d-52dc1ab2b70f+drop-commas`                 | `CARTER COUNTY`    |
| `usgov-nad:usgov-nad-7e91373b-2534-409f-b86c-cc21da475a69-14e708a455dd+state-expand`                | `CARTER COUNTY`    |
| `usgov-nad:usgov-nad-713115d8-2a30-45a1-b0fc-bee131ba0627-97ffffb7def1+state-expand`                | `JOHNSTON COUNTY`  |
| `usgov-nad:usgov-nad-c70553c9-b6ce-4476-983a-06556cafa242-ae7e91fc7f56+us-street-suffix-abbreviate` | `CARTER COUNTY`    |
| `usgov-nad:usgov-nad-12e021cd-d927-4a04-8ba9-a9b55020fea6-1b97ca588f45+us-street-suffix-abbreviate` | `CARTER COUNTY`    |
| `usgov-nad:usgov-nad-e460f81a-0adb-4dfa-9374-f8d8bdd95dbd-efeb14a4f288`                             | `CARTER COUNTY`    |
| `usgov-nad:usgov-nad-d75d4fac-73ef-4f0d-885b-650e6fc4fa84-e4528e45c7a7+state-expand`                | `CARTER COUNTY`    |

Development probes, `heldout-dev-v0.8.19-probes-r2`: `invented-po-box-cedex:invented-po-box-cedex-c50bb464906b`,
`Post Office Box 9255, SCOTT COUNTY, IA 52753`, span `SCOTT COUNTY`.

The overlap audits match by row identity, group and folded text, none of which the relabel changes, so the v2
audit files and the probe audits class the v3 rows. Section 5 lists the file each verdict read.

## 3. The 44 FR rows

Decided: the rows leave `postal_unit`, and no check reads them. Each probe set holds 44 FR
`invented-postal-unit-guideline` rows rendered as a named complex, such as
`LOTISSEMENT SILLINGY, 9 RUE DE PEYRIAT, 72800 LUCHÉ-PRINGÉ` with spans `venue`, `house_number`, `street`,
`postcode` and `locality`. No row holds a `unit` span, so none tests the `postal_unit` task, which reads a
designator with its identifier as one unit component. v8's other checks:

| Check           | Task                                                                    | Source selected                                      | Fits the rows                     |
| --------------- | ----------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------- |
| `venue_unit`    | A venue name and its unit designator ahead of the street line           | `spliced-sub-venue`                                  | no: the rows hold no unit         |
| `po_box_cedex`  | A PO Box, locked bag or CEDEX designator beside an intact locality line | `invented-po-box-cedex`, `invented-postal-guideline` | no: the rows hold no box or CEDEX |
| `country_token` | A trailing country name tagged country                                  | `spliced-country`                                    | no                                |

The rows would also leave the FR country cell under any selector, because their source is a capability probe.
V9 adds the selector field `withoutTags`, and `postal_unit` selects `withoutTags: ["venue"]`. The field reads each
outcome's expected tags, which `heldout/per/country.ts` now records, and the evaluator refuses a row without them
rather than reading it as unselected. The only rows it removes are these 88: a search of all four collections
found a `venue` span in no other `invented-postal-unit-guideline` row, and the v0.8.18 collections hold no FR
row of that source. `postal_unit` reads 956 groups of each probe set where it read 1,000 (1,017 and 965 with the
v0.8.18 probe rows), and its threshold is unchanged. A named complex beside a street line would need its own capability, with its own task and minimum.
None is registered.

## 4. What v9 changes

1. **Each role lists its collections.** `evaluations.<role>.ids` and `identities.dataset` are lists in spec
   schema 4 (`release/requirements.ts`). The reader refuses schema 3, and the v4 to v8 files stay as the record
   of what they registered. `heldout/per/country.run.ts --dataset a,b` scores a role's collections together,
   refuses a row identity two of them hold (`mergeHeldoutCollections`), and takes one provenance file per
   collection. `release/collection.ts` verifies every collection a report lists. The verdict records the role the
   collections make up, and a report that scores no role exactly reads insufficient evidence.
2. **The county relabel**, section 2. The v0.8.18 pins move to the v3 manifests, and the development probe pin
   moves to `heldout-dev-v0.8.19-probes-r2@dd560a53b897dbca`.
3. **`postal_unit` leaves out venue rows**, section 3.
4. **A geocode check.** A requirement of kind `geocode` bounds the loss in the equal-country rate of each arm's
   geocode outcome over the nine objective countries' address rows, with the probes left out, at
   `maxLoss` 0.01. It registers no minimum. The outcome (`heldout/per/geocode-outcome.ts`) is exact when the
   geocode's components, `dropped_components` included and folded, equal the expected spans, the street family
   joined into one bag of words under the `whole` convention, and every expected `locality`,
   `dependent_locality`, `subregion`, `region` and `country` span is a hierarchy entry at its tag.
   `heldout/per/geocode.ts` geocodes through `buildGauntletDeps`, the path lane Y's comparison graded. An arm
   label may pin resolver switches, `<root>#countyDesignatorFallback=on` (`heldout/per/arm.ts`), and arms with one
   root share one parse. `--geocode` geocodes the rows the spec's geocode requirements select, with each distinct
   arm. A selected row without a geocode outcome makes the check insufficient. When the two arms' `model.onnx`
   sha256 are equal, the check reads the classes `sameModelAdmitted` lists (`verified_unseen`,
   `unseen_by_candidate`, `known_overlap`), because a row the one model trained on favors neither arm. Otherwise
   it reads the comparative class. Commit `942479d970` added this rule after the first county verdict read the check at
   0.0000 [−0.0342, 0.0342]. Development holds 28 comparative US groups, and every row the fallback moved was
   `known_overlap`.
5. **Bonferroni over 16 checks** in place of 15, from the geocode check.
6. **The confirmation reads** before registration are listed in the rationale, as the proposal asked: 10.8.0's one
   baseline scoring of each probe confirmation set (r1 and r2), and under v8 the v8.7.0 seed 42 reads of
   `heldout-confirm-v0.8.18` on 2026-11-16 (postal card: fail, shaped card, and the fixed repair: insufficient
   evidence) and lane AD's seed 43 read. Under section 6.5 of the specification, the failed seed 42 read retires
   the v0.8.18 confirmation rows for recipe selection. The v3 collection holds the same rows and keeps that status.
   The next release-directed run needs a successor confirmation draw.

## 5. Verdicts under v9

Published arm `/mnt/mw/models/arms/v870/roots/shipped-10.8.0` (`model.onnx` sha256 `0bbb3385…a4`, the
registered identity), Bonferroni over 16 checks. Each report scores one role's two collections with
`--geocode`. Provenance: for 10.8.0 against itself and the county pair, development reads
`heldout-dev-v0.8.18.v2.provenance-published-10.8.0.json` and confirmation reads
`heldout-confirm-v0.8.18.v2.provenance.json`. That file's published card is 10.7.0, so its comparative class is
narrower than 10.8.0 against 10.8.0 needs, and the bounds are conservative. The v8.7.0 seeds read lane V's
`/mnt/mw/models/arms/v870/heldout-{dev,confirm}-v0.8.18.v2.provenance-v870.json`. Both probe sets read their r2
audits. Reports and verdicts are under `/mnt/mw/models/arms/v9/`. Every verdict also states
`the candidate artifact identity is unregistered`, so none can pass.

The confirmation reads here are 10.8.0's baseline scoring of the v9 confirmation role (allowed once per version),
the county pair, and both v8.7.0 seeds. Under section 6.5 these go into v10's rationale.

### 5.1 10.8.0 against itself: `fail`, both roles

`fail` comes from `postal_unit`, the published model's own miss.

| Check                  | Development              | Outcome      | Confirmation             | Outcome      |
| ---------------------- | ------------------------ | ------------ | ------------------------ | ------------ |
| `country-US`           | 0.929 [0.673, 0.998], 28 | pass         | 0.846 [0.407, 0.995], 13 | insufficient |
| `country-FR`           | 0.981 [0.844, 1.000]     | insufficient | 1.000 [0.889, 1.000]     | insufficient |
| `country-GB`           | 0.997 [0.985, 1.000]     | pass         | 1.000 [0.993, 1.000]     | pass         |
| `country-DE`           | 0.993 [0.979, 0.999]     | pass         | 0.995 [0.982, 0.999]     | pass         |
| `country-IN`           | 0.865 [0.815, 0.906]     | pass         | 0.894 [0.828, 0.941]     | pass         |
| `country-ES`           | 0.858 [0.822, 0.890]     | pass         | 0.877 [0.843, 0.906]     | pass         |
| `country-IT`           | 0.848 [0.811, 0.880]     | pass         | 0.840 [0.803, 0.872]     | pass         |
| `country-AU`           | 0.981 [0.958, 0.993]     | pass         | 0.977 [0.954, 0.991]     | pass         |
| `country-NZ`           | 0.960 [0.923, 0.983]     | pass         | 0.923 [0.776, 0.987]     | insufficient |
| `po_box_cedex` minimum | 0.846 [0.828, 0.862]     | insufficient | 0.849 [0.831, 0.865]     | insufficient |
| `po_box_cedex` loss    | 0.000 [−0.002, 0.002]    | pass         | 0.000 [−0.002, 0.002]    | pass         |
| `venue_unit`           | 0.988 [0.898, 1.000]     | pass         | 0.961 [0.847, 0.997]     | insufficient |
| `country_token`        | 1.000 [0.928, 1.000]     | pass         | 1.000 [0.933, 1.000]     | pass         |
| `postal_unit`          | 0.725 [0.682, 0.765]     | **fail**     | 0.720 [0.676, 0.762]     | **fail**     |
| `geocode` loss         | 0.000 [−0.003, 0.003]    | pass         | 0.000 [−0.012, 0.012]    | insufficient |
| objective              | 0.000 [−0.034, 0.034]    | insufficient | no ES, IT, AU, NZ rows   | insufficient |

The confirmation objective has no comparative rows for four countries, because that provenance file compares
against 10.7.0's lineage. The geocode check reads every recorded class here, because both arms load one model.
NZ's 73 confirmation rows set its width.

### 5.2 `countyDesignatorFallback` on against off: `fail`, both roles. The default stays off

Every exact-parse check is identical to 5.1 by construction. The geocode check:

| Role         | Estimate [bound]                       | Outcome      | Rows moved            |
| ------------ | -------------------------------------- | ------------ | --------------------- |
| Development  | +0.0016 [−0.0014, +0.0045], 8,676 rows | pass         | 14 US fixed, 0 broken |
| Confirmation | +0.0019 [−0.0101, +0.0139], 7,279 rows | insufficient | 17 US fixed, 0 broken |

Every moved row is a relabeled `usgov-nad` Carter or Johnston County row, `known_overlap` for 10.8.0, and no row in
any other country moved. Of the 23 + 22 relabeled rows, 14 + 17 became exact. The others stay wrong on both arms:
the `state-expand` rows, where 10.8.0 parses `Oklahoma` as the locality, the rows whose unit or venue the parse
loses, and the 2 IE `co Dublin` rows, which the fallback doesn't resolve. 10.8.0 parses one as `locality=co Dublin`
and the other as `venue=co`, `locality=Dublin`, on both arms.

The verdict is `fail` on both roles, from `postal_unit`, a published-model miss the switch can't move. It also
records the unregistered identity and an undecided objective. The rule permits default-on only on `pass`, so
`countyDesignatorFallback` stays **off**. The geocode check is the first instrument to show the change as a
gain against the answer key, with no row lost. It is a pass on development, and on confirmation its lower bound
misses −0.01 by 0.0001.

### 5.3 v8.7.0 against 10.8.0, seeds 42 and 43 (postal card, int8)

`n42-i8` and `n43-i8` under `/mnt/mw/models/arms/v870/roots/`, scored in one report per role.

| Check                  | s42 development                   | s43 development               | s42 confirmation                    | s43 confirmation                    |
| ---------------------- | --------------------------------- | ----------------------------- | ----------------------------------- | ----------------------------------- |
| `country-US`           | 0.845 pass                        | 0.840 pass                    | 0.824 pass                          | 0.822 pass                          |
| `country-FR`           | 0.996 pass                        | 0.996 pass                    | 0.988 pass                          | 0.986 pass                          |
| `country-GB`           | 0.991 pass                        | 0.991 pass                    | 0.995 pass                          | 0.995 pass                          |
| `country-DE`           | 0.987 pass                        | 0.987 pass                    | 0.989 pass                          | 0.989 pass                          |
| `country-IN`           | 0.933 pass                        | 0.933 pass                    | 0.961 pass                          | 0.954 pass                          |
| `country-ES`           | 0.974 pass                        | 0.979 pass                    | 0.980 pass                          | 0.980 pass                          |
| `country-IT`           | 0.995 pass                        | 0.993 pass                    | 0.995 pass                          | 0.993 pass                          |
| `country-AU`           | 0.989 pass                        | 0.927 pass                    | 0.985 pass                          | 0.931 pass                          |
| `country-NZ`           | 0.958 pass                        | 0.951 pass                    | 0.945 pass                          | 0.959 pass                          |
| `po_box_cedex` minimum | 0.881 [0.865, 0.895] pass         | 0.894 [0.879, 0.908] pass     | 0.886 [0.870, 0.900] pass           | 0.901 [0.886, 0.914] pass           |
| `po_box_cedex` loss    | +0.035 pass                       | +0.049 pass                   | +0.037 pass                         | +0.052 pass                         |
| `venue_unit`           | 0.988 pass                        | 1.000 pass                    | 0.974 pass                          | 0.987 pass                          |
| `country_token`        | 1.000 pass                        | 1.000 pass                    | 1.000 pass                          | 1.000 pass                          |
| `postal_unit`          | 0.825 [0.787, 0.859] insufficient | 0.771 [0.730, 0.809] **fail** | 0.815 [0.775, 0.850] **fail**       | 0.765 [0.722, 0.804] **fail**       |
| `geocode` loss         | +0.037 [0.016, 0.058] pass        | +0.039 [0.017, 0.060] pass    | +0.037 [−0.035, 0.108] insufficient | +0.036 [−0.035, 0.107] insufficient |
| objective              | +0.045 [0.024, 0.066] pass        | +0.047 [0.031, 0.062] pass    | +0.043 [−0.029, 0.114] insufficient | +0.040 [−0.032, 0.111] insufficient |
| **Verdict**            | insufficient evidence             | fail                          | fail                                | fail                                |

Seed 42's confirmation `postal_unit` upper bound is 0.84990, below 0.85 by 0.0001. Under v8, which read only
the v0.8.18 probe rows, it was insufficient evidence, and v9 reads 965 groups. Both seeds now decide
`po_box_cedex` on both roles, where v8 read insufficient evidence. AU separates the seeds (0.989 and 0.927 on
development).

Geocode rows moved against 10.8.0, fixed and broken:

| Arm, role                    | AU     | ES      | IT      | IN      | NZ     | US      | DE, FR, GB |
| ---------------------------- | ------ | ------- | ------- | ------- | ------ | ------- | ---------- |
| s42 development (8,676 rows) | +94 −0 | +110 −3 | +99 −2  | +50 −19 | +23 −4 | +43 −14 | +4 −2      |
| s43 development              | +24 −0 | +117 −2 | +96 −2  | +50 −28 | +21 −1 | +43 −18 | +3 −4      |
| s42 confirmation (7,279)     | +80 −1 | +107 −6 | +115 −0 | +23 −8  | +6 −1  | +69 −16 | +4 −5      |
| s43 confirmation             | +21 −0 | +109 −7 | +113 −1 | +22 −10 | +6 −0  | +71 −24 | +3 −5      |

## 6. What remains

- A pass for any candidate needs a registered candidate identity, `postal_unit` above 0.85, and an objective
  interval the confirmation role can narrow. The confirmation objective has 13 US and 73 NZ comparative groups
  under the v870 audit.
- The v0.8.18 confirmation rows are retired for recipe selection (section 4, item 6). The next release-directed
  run needs a successor confirmation draw.
- The IE `co Dublin` rows show the fallback doesn't reach Dublin, and lane Y's board convention expects IE counties
  as `region` (`Co. Westmeath`). Which tag an IE county takes in the answer key is a decision this record doesn't
  make. The relabel follows the operator's rule, which assigns `subregion` to every county in the town position.

## Reproduce

Scripts in `scratchpad/2026/11/17/lane-af/` of the lane worktree: `survey.ts` (the designator and venue search),
`restamp-all.ts` (section 1 after the two v0.8.18 restamps), `geocode-smoke.ts`, and `geocode-moved.ts` (the
moved-row tables). The four reports are `/mnt/mw/models/arms/v9/heldout-{dev,confirm}-v9-{county,v870}.json`, and
the verdicts are `verdict-{dev,confirm}-{10.8.0-self,county-on,n42-i8,n43-i8}.json` beside them.
