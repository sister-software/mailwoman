# Promotion check migration to release quality requirements

Date: 2026-10-20. Issue #2763. Policy: release quality requirements replace the D-rule (operator-confirmed
2026-10-20), implementation steps 5 and 6.

This record lists every promotion check that existed on the tree at `origin/main` 4cf3c16e6 and states whether
it is retained, replaced or retired, why, and where its replacement lives. The policy requires each current check
to be accounted for before the D-rule replacement becomes the release authority.

## Where this record lives

It is a dated record under `docs/records/evals/` rather than a file beside the release specification. The
specification directory `packages/mailwoman/tools/eval-harness/release/` belongs to a concurrent lane, and a
migration table states the tree on one date, which is what `docs/records/` holds. The Docusaurus build reads
`docs/articles/` only, so this page needs no sidebar entry. A later specification version that registers a
replacement updates the row it settles and names that version.

## Status vocabulary

- **retained-pending**: the check still runs and still decides `mwdev_promotion_eval`. No registered requirement
  in `release-requirements.v1.json` replaces it, because v1 registers no requirement, objective set or threshold.
  The check stays in code until a specification version registers its replacement and that replacement runs.
- **replaced**: the check no longer decides anything in code, and its replacement exists on this branch.
- **retired**: the check is removed without a replacement, for the stated reason.
- **retained**: the check stays as it is, with a role the policy keeps.

## Graded arc (`lib/dev-mcp/arc.ts`, `mwdev_arc`)

| Check                                                              | Status   | Reason                                                                                                                                                                                      | Replacement                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-rule: any board regression in FR or US (tier 1) blocks the ship  | replaced | Historical country privilege. The policy grants FR, US, DE and GB additional requirements only when a stated product need justifies them, and their former D-rule inclusion grants no veto. | Release eligibility read from the release verdict (`readReleaseEligibility`). A required country is a `CountryRequirement` in a release spec version.                                                         |
| D-rule: any board regression in DE or GB (`dRuleProtected`) blocks | replaced | Same as above. The recorded reasons (thin DE board, GB's checking-row count) describe board detectability rather than a product requirement.                                                | Same as above. `dRuleProtected` is removed from `scope.config.json`.                                                                                                                                          |
| Board net must be positive to ship                                 | replaced | The board is a curated failure-finding collection whose row counts do not decide promotion.                                                                                                 | Board regressions are `findings` with the input, both arms' output and the checker's issues. The objective improvement `Q_candidate - Q_published` in the release verdict decides improvement.                |
| Attributable net (candidate minus null) must be positive to ship   | replaced | Training attribution and release eligibility are distinct answers.                                                                                                                          | Still computed and reported as `attribution.net` and `attribution.regressions`, and it no longer decides release eligibility.                                                                                 |
| Self-control leg must show zero differing rows                     | retained | A rig that disagrees with itself produces no evidence about the candidate.                                                                                                                  | Unchanged. A dirty control sets `attribution.attributable` to false. It does not set release eligibility, which comes from the held-out verdict rather than this rig.                                         |
| Null leg absent on a fine-tune: regression count is an upper bound | retained | Attribution arithmetic.                                                                                                                                                                     | Unchanged, reported under `attribution.reasons`.                                                                                                                                                              |
| Verdict `ship / hold / unattributable`                             | replaced | One word combined attribution and eligibility.                                                                                                                                              | `release.outcome` (`pass`, `fail`, `insufficient_evidence`) and `attribution.attributable`. A missing verdict is `insufficient_evidence`. A verdict for another model.onnx sha256 or spec version is refused. |

## Repository checks

| Check                                                                                                           | Status   | Reason                                                    | Replacement                                                                                                       |
| --------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `locale-scope`: a `dRuleProtected` entry needs a reason, may not name tier 1, may not name an uncovered country | retired  | The register it validated is removed.                     | None. Release requirements carry their own `reason` field, validated by `validateReleaseSpec`.                    |
| Coverage funnel `protected` stage (tier 1 or `dRuleProtected`)                                                  | replaced | It reported the historical privilege as a coverage stage. | `required` stage: a country named by a `CountryRequirement` in the current release spec (`CURRENT_RELEASE_SPEC`). |

## Promotion battery (`mwdev_promotion_eval`, spec `packages/mailwoman/tools/eval-harness/specs/v9.0.0-base.json`)

The floors are declared in the spec's `floors` object and enforced in
`packages/mailwoman/tools/eval-harness/promotion/eval/verdict.ts`, except `fr.bare_street_intact` and
`arena.perturb`, whose legs in `promotion/eval.ts` exit non-zero. Each floor was derived from the published
model's reading minus a Wilson margin. The policy says the published model's past answers do not define the
minimum acceptable quality, so each floor's numerical derivation is to be replaced by a registered minimum with a
stated product reason. None is registered in v1, so every floor below is **retained-pending** and still decides
`mwdev_promotion_eval`.

| Floor                     | Value | Instrument                          | Status           | Proposed replacement (not yet registered)                                                                            |
| ------------------------- | ----: | ----------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `us.postcode`             |  93.7 | per-locale F1, US golden            | retained-pending | US country requirement on exact parse, with postcode span F1 kept as a diagnostic                                    |
| `us.country_homograph_f1` |  64.8 | score-country-homograph (n=54)      | retained-pending | Capability: distinguishing a country name from a homograph, exact parse on the homograph fixture                     |
| `us.micro`                |  82.9 | per-locale micro F1, US             | retained-pending | US country requirement on exact parse, with micro F1 as a diagnostic                                                 |
| `us.locality`             |  79.6 | per-locale F1, US                   | retained-pending | US country requirement, locality F1 diagnostic                                                                       |
| `us.region`               |  89.4 | per-locale F1, US                   | retained-pending | US country requirement, region F1 diagnostic                                                                         |
| `us.street`               |  67.7 | per-locale F1, US (unfolded)        | retained-pending | Capability: street name versus affix split                                                                           |
| `us.street_prefix`        |  57.0 | score-affix (n=25)                  | retained-pending | Capability: street affix recovery                                                                                    |
| `us.street_suffix`        |  69.9 | score-affix (n=30)                  | retained-pending | Capability: street affix recovery                                                                                    |
| `us.unit_real`            |  73.0 | score-affix unit designators (n=34) | retained-pending | Capability: unit recovery                                                                                            |
| `fr.postcode`             |  98.8 | per-locale F1, FR                   | retained-pending | FR country requirement, if a product need is stated                                                                  |
| `fr.house_number`         |  96.6 | per-locale F1, FR                   | retained-pending | FR country requirement, if a product need is stated                                                                  |
| `fr.region`               |  36.7 | per-locale F1, FR                   | retained-pending | FR country requirement or retirement. A 36.7 floor states a historical reading rather than a product need            |
| `de.native_locality`      |  89.5 | de-order-eval anchor-on cell        | retained-pending | DE country requirement, if a product need is stated                                                                  |
| `arena.perturb`           |  59.9 | perturbation arena (n=398)          | retained-pending | Capability: robustness to perturbed input, or diagnostic                                                             |
| `us.po_box_real`          |  94.3 | PO Box fixture (n=2000)             | retained-pending | Capability: reading a PO Box                                                                                         |
| `fr.cedex_real`           |  92.4 | CEDEX fixture (n=430)               | retained-pending | Capability: reading a CEDEX designator                                                                               |
| `us.intersection_real`    |  80.7 | intersection fixture (n=36)         | retained-pending | Capability: intersection parse                                                                                       |
| `fr.bare_street_intact`   |  75.0 | fr-bare-street leg (designed, #949) | retained-pending | Capability: a bare French street stays intact. It is a designed tolerance, so its value may carry over with a reason |

## Other promotion-battery checks

| Check                                                           | Status           | Reason                                                                                                                         | Replacement                                                                                                                                                  |
| --------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `int8_vs_fp32_max_delta_pp` 1.5 (per floor, only with `--int8`) | retained-pending | The policy requires the exported, quantized release artifact to be evaluated itself.                                           | The release verdict is tied to the exact `model.onnx` sha256, so the int8 artifact is evaluated directly. The cap stays until release specs drive promotion. |
| Mask-regression lock (#718), conventions mode only              | retained-pending | A tag regressing more than 2pp under the conventions mask compares against the published model's answers.                      | Capability requirement on the masked path, or retirement, decided in a later spec version.                                                                   |
| Tokenizer comparability refusal (exit 2)                        | retained         | A measurement-validity refusal, which the policy requires ("refuse missing required artifacts").                               | Unchanged.                                                                                                                                                   |
| fp32/int8 mislabel and byte-identical arm refusals (exit 2)     | retained         | Measurement validity and artifact identity.                                                                                    | Unchanged. The release verdict adds the sha256 identity check.                                                                                               |
| Compiled-freshness warning                                      | retained         | Measurement validity of the harness itself.                                                                                    | Unchanged.                                                                                                                                                   |
| `cascade.demo_smoke` (read by the verdict, unfloored in v9.0.0) | retained         | Not a floor in the current spec. A geocoding requirement would be measured through the served path with annotated coordinates. | Geocoding requirement in a later spec version, if one is registered.                                                                                         |
| Preset compare                                                  | retained         | Smoke test for tag collapse. It never decided promotion.                                                                       | Unchanged.                                                                                                                                                   |
| `$watch` entries in `v9.0.0-base.json`                          | retained         | Recorded observations without a floor.                                                                                         | Unchanged.                                                                                                                                                   |

## Not changed in this lane

- `docs/engineering/CONTRIBUTING_MODEL_WORK.mdx`, the evaluation skills and the repository-root `AGENTS.md`
  review rule "Default-on model behavior" still describe the D-rule. Step 7 of the policy updates them together.
  The one `dRuleProtected` reference in the runbook now reads as the register's state at the time of its
  measurement.
- `mwdev_promotion_eval` still decides on the floors above. Until a release spec registers requirements, every
  release verdict is `insufficient_evidence`, so `mwdev_arc` reports release eligibility as insufficient evidence
  for every candidate.

## Specification v3 (2026-10-20)

`release-requirements.v3.json` registers the requirements decided in `2026-10-20-release-requirements-v3.md`.
That record's section 6 settles the retained-pending rows above:

- Fifteen floors in `v9.0.0-base.json` are replaced by the nine country requirements and the `po_box_cedex`,
  `venue_unit` and `country_token` capabilities.
- `us.street_prefix`, `us.street_suffix`, `us.intersection_real`, `arena.perturb` and `fr.bare_street_intact`
  are retired as deciders and stay as diagnostics.
- The 1.5 pp int8-vs-fp32 cap is retired, because the verdict is tied to the int8 artifact's sha256.
- The mask-regression lock is retained as a configuration check outside the specification. It compares the
  candidate with and without the ship config's conventions mask and does not read the published model's
  answers, so the row above that describes it as a comparison against the published model is inaccurate.

The floors stay in `v9.0.0-base.json` and `mwdev_promotion_eval` until the first v3 verdict runs on a frozen,
audited dataset. Every v3 verdict is `insufficient_evidence` until the evaluation collection holds
`verified_unseen` address rows for ES, IT, AU and NZ.
