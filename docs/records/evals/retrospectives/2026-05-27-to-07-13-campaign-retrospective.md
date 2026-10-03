---
title: "Night-shift campaign: outcomes and lessons, May–July 2026"
description: "Consolidated record of the parser, geocoder, matching, and evaluation campaign, with corrected conclusions and reusable lessons."
---

# Night-shift campaign: outcomes and lessons

## Scope and evidence

This retrospective condenses 34 dated reports from May 27 through July 13, 2026. The reports contain
overlapping sessions, duplicate night numbers, daytime continuations, and corrections written after
their initial verdicts. They are not 34 independent experiments. Later corrections take precedence
over earlier recommendations and summary tables.

**Observed** below means reported in those records, not independently rerun for this consolidation.
**Decision** identifies a historical choice; **inference** identifies an interpretation; **unknown**
identifies evidence the records do not establish. Release names, coverage, and outstanding work are
historical. This document does not describe the current production system or replace current release
and evaluation requirements.

The complete source is recoverable from the
[archive at commit `492faf521642185049fd8e6c99a5d2226674235b`](https://github.com/sister-software/mailwoman/tree/492faf521642185049fd8e6c99a5d2226674235b/docs/records/evals/night-shifts).
The directory contained 5,434 lines across 34 reports and two navigation files. Its running PR counts,
GPU estimates, and release statuses are too inconsistent to support a campaign-wide total.

## What the campaign accomplished

**Observed:** the work progressed from a browser address parser into a geocoder with address-point and
interpolation tiers, broader international retrieval, calibrated confidence, compatibility APIs, and
record matching. In parallel, evaluation progressed from a few successful examples and tag scores to
tests of the assembled pipeline, independent data, geographic coverage, and input transformations.

| Period         | Outcome                                                                                                                                                                                                           | Limit retained from the records                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| May 27–29      | Browser FST gazetteer, coordinated model/tokenizer staging, Stage 3 labels, PO box synthesis, postcode repair, and per-tag evaluation. v0.6.0 became default.                                                     | Successful presets concealed regressions: experimental v0.6.1 lost 8.6 percentage points of locality recall despite 11/11 presets passing.                                                         |
| June 2–8       | Native-order corpus work, postcode anchors on Node and browser, Japan coarse resolution, calibration tooling, city-state recovery, US region abbreviations, and hierarchy repairs.                                | German name-match scores conflated naming differences with unresolved places. Japan's construction-source result needed an independent cross-check; Korea remained experimental.                   |
| June 9–13      | Unit/affix and boundary work reached v4.2.0 and v4.4.0; character-offset corpus work supported bridge retirement. FR order recovery shipped as v4.6.0 after an explicit floor change.                             | Corpus and evaluation composition changed. The v0.5.0 corpus rebuild also incorporated more WOF data, so it was not a pure format comparison.                                                      |
| June 14–18     | US address points and national interpolation, geocoding/batch APIs, browser street lookup, record-matching experiments, and evaluation-integrity repairs.                                                         | Raw-neural scoring missed a destructive reconcile stage. Browser correctness alone missed full-file downloads. A model promotion recommendation was retracted after checking the shipped baseline. |
| June 19–28     | FR admin splitting shipped as v4.11.0; multi-locale and AU models followed. Candidate gazetteer coverage, postal-city lookup, confidence routing, and Nominatim/Photon/libpostal compatibility surfaces advanced. | Coverage depended on artifact and backend. Comparative claims required matching configurations and valid competitor responses. Some database changes were staged before later promotion.           |
| June 29–July 5 | Regression, metamorphic, and held-out tests formed the Gauntlet; normalization, explicit-country coherence, and postcode coverage addressed measured failures without retraining.                                 | New locale panels exposed regressions that earlier model checks could not see. Several country and namesake fixes remained conditional on data and default settings.                               |
| July 13        | Fragment-data experiments improved parity on the existing architecture; tokenizer consolidation and locality counterexamples produced a Gauntlet-passing candidate.                                               | v2.5.3 remained staged. Per-locale F1 and error-analysis checks were outstanding; the stated house-number and street parity floors were still unmet.                                               |

## Results worth retaining

**Observed — resolver structure mattered more than another German retrain.** On the June 7
international-order German set of 3,000 rows, Saxony had 75.9% point-in-polygon correctness but only
51.1% name-match. Berlin had a separate city-state failure: 955/1,500 rows were unresolved. With the
v0.9.4 model held fixed, city-state recovery increased Berlin containment from 36.3% to 80.9%.
The June 6 claim of a fundamental anchor/order limitation was therefore too broad. Naming equivalence,
city-state structure, and residual parser fragmentation needed separate treatment.

**Observed — correct names could still identify the wrong state.** On 1,428 geographically held-out
Vermont addresses, name-match was 93.7% while region-match was 0%. Adding region abbreviations
raised region-match to 99.9%. However, `350 5th Ave, New York, NY` then selected New York Mills
instead of New York City: NYC's multiple-parent hierarchy had been lost by a parent-pointer closure.
Rebuilding ancestry from `wof:hierarchy` restored the preset. The full-US 10,000-row abbreviation-only
arm reduced coordinate p90 from 2,763.5 km to 10.3 km; the report did not finish the corresponding
full-US combined-arm table. Do not attribute that exact number to an unreported combined run.

**Observed — assembled-pipeline evaluation reversed model conclusions.** The June 14 audit found
joint reconcile destroyed the street/house-number geocoding precondition on 77–84% of the tested
clean US addresses. Raw-neural evaluations never exercised that stage. A later recheck still found
5.6% precondition failures and a 13.7-point FR street regression after the grouper repair, so reconcile
remained retired. On June 18, v1.7.0's apparent improvement also disappeared when compared with
the actually shipped v1.5.0, using its anchor and gazetteer channels. The supposed rural locality gap
then disappeared when the scorer credited `localadmin` towns; the supposed coordinate limitation
disappeared when the evaluator invoked the shipped street cascade. On the same 10,000 US rows, the
cascade measured 85.9% within 100 m, followed by approximately 89.5% after street-key repairs.
See the retained [model comparison](../model-versions/2026-06-18-v150-vs-v170-head-to-head.md) and
[cascade evaluation](../resolver-geo/2026-06-18-situs-cascade-eval.md).

**Observed — targeted model changes also delivered.** The v1.8.0 FR admin-split experiment used a
3,000-row golden with disjoint communes and anchor-on inference. Against v1.5.0, median coordinate
error fell from 42.52 km to 2.17 km and resolve rate rose from 59.5% to 78.5%. The historical release
accepted disclosed US locality and FR country label regressions with operator approval. A supplied
country hint made the latter invisible to that coordinate test; it did not establish harmlessness for
all parser consumers. The later v1.8.1 country-data experiment was shelved: it barely improved country
F1 and regressed other labels. These historical exceptions do not override today's regression rules.

**Observed — postal-city aliases required postcode scope.** On June 21, the FTS resolver's alias
experiment fixed 500 of 10,155 divergent postal-city edges, with zero regressions under the report's
50 km criterion. Its p90 fell from 278.1 km to 10.1 km. A candidate-backend experiment used a different
population of 9,688 edges: 2,221 fixes and three regressions, with p90 still 768 km. Those results are
not interchangeable. Cloning aliases into ordinary name ranking could not preserve both bare-name
behavior and postcode disambiguation; a `(name_key, postcode)` side index supplied the missing scope.

**Observed — broader retrieval needed complete data flow.** Adding 843,739 Canadian postcodes did
not fix `100 Queen Street West, Toronto, ON M5H 2N2`: the missing Canadian admin layer selected
Toronto, Ohio, then rejected the correct Canadian postcode. Adding admin places, rebuilding alias
indexes, and supplying population evidence repaired the cascade. Later GeoNames builds expanded
coverage beyond the 97-country artifact. On the June 28 matched frontier experiment, hinted resolve
rate rose from 51.0% to 94.1%; existing supported-case coordinates stayed identical. That frontier
sampled major cities, so it could not validate village-level coverage. Historical “244 countries” counts
describe source country-code coverage, including territories, not 244 independently validated locales.

**Observed — postcode availability could eliminate a purported ranking problem.** On July 2,
adding experimental postcode data reduced Finland's namesake errors from 300/1,000 to 1/1,000 and
Czechia's from 131/1,000 to 4/1,000. Enabling `postcodeConsistency` added no change over the
data-only control: existing coordinate-first retrieval already consumed the new evidence. Crude
centroids nevertheless worsened median precision enough to fail checks in Slovakia, Slovenia, and
Croatia. Coverage gains required precision checks and the same normalization at build and query time.

**Observed — confidence supported selective use, with a coverage cost.** A 472-address messy OA
sample across six locales was split into 236 rows for the threshold curve and 236 for validation.
On the curve half, v4.13.0's right-place precision rose from 84.3% to 97.3% between thresholds 0
and 0.94, while the accepted fraction fell from 67.4% to 15.7% (called recall in the original report).
On the validation half, precision was 85.9% for 92 high-confidence answers versus 72.1% for 68
low-confidence answers. Calibration needed checking against the
specific model and locale; the interpolation-radius multiplier fitted in Texas also varied materially
across 12 states. Confidence calibration, error discrimination, and geographic uncertainty are separate
claims. See the retained [confidence experiment](../calibration/2026-06-24-confidence-precision-change.md).

**Observed — record matching needed a declared entity definition.** On identical clusters, changing
truth from NPI to organization-at-location moved reported F1 from 53.6% to 68.1%; that was a
measurement change. Separately, a gradient-boosted scorer improved held-out clustering F1 from 55.3%
to 60.5% across four seeds in the 2,000-NPI experiment, reporting each scorer's best F1 over a
threshold sweep. Those are optimized experimental results, not an independently tested fixed
production threshold. Larger cross-state gains were single-seed directional evidence.
Phone corroboration failed because institutional switchboards were shared;
average linkage lost true name-drift matches. The final cross-source count was 219 linked entities,
but 191 were FCC-internal: only 28 crossed agencies, all pairwise. See the retained
[clustering experiment](../matcher-dedup/2026-06-16-learned-scorer-clustering.md) and
[setting comparison](../matcher-dedup/2026-06-22-nppes-dedup-setting-ladder.md).

## Lessons to carry forward

The following are **decisions for preserving the campaign's lessons**, grounded in the incidents above.
Current repository skills and runbooks remain the operational authority.

1. **Establish artifact identity before interpreting a score.** Record model and tokenizer hashes,
   model card, data versions, compiled code, backend, flags, and supplied country hints. Reproduce the
   baseline in that exact environment. The latest training run, development symlink, npm release, and
   demo default repeatedly referred to different models. Incremental compilation also left old code
   in place; a source-level unit test did not establish what a compiled evaluator executed.

2. **Grade the public entry point and retain component checks.** Follow normalization, tokenization,
   classification, grouping, resolution, serialization, and browser delivery. Coordinate success does
   not excuse lost parser components; per-tag success does not establish correct geocoding. Test Node
   and browser paths when their implementations differ. Measure bytes transferred as well as a correct
   browser pin: the HTTP VFS once fetched an entire 3.2 GB extract merely to discover its length.

3. **State denominators and measurement conditions.** Report resolved fraction alongside correctness
   over all inputs and precision among resolved inputs. Separate name equivalence from geographic
   correctness. Use distance only where the evaluation defines it; a 25 km success threshold does not
   demonstrate rooftop precision. Venue support of one FR row and unit support of zero were missing
   evidence, not established model failures. Keep representative inputs separate from adversarial tests.

4. **Read failing rows before assigning a cause.** Identify the first divergent stage and test the
   cheapest alternative explanation. Repeatedly, “missing coverage” meant an omitted placetype, stale
   index, absent feature channel, wrong backend, or incorrect gold. An explicit country constraint
   recovered 45/57 targeted countries without the proposed placer retrain. A July 5 lowercase
   normalizer resolved failures previously treated as necessarily requiring model work.

5. **Use controls that separate data, code, and training effects.** The postcode data-only control
   exposed an existing working mechanism. Training comparisons also need a matched continuation
   without the new intervention. A corpus rebuilt from the same adapter list can still change source
   contents. Compare equal inference conditions and quantization; do not combine numbers from
   different harnesses into a measured claim.

6. **Register broad checks before tuning, then obey them.** Include affected locales in small probes
   as well as full evaluations: FR bare-street training passed a narrow probe before failing Slovenian
   village-number inputs. Keep regression, metamorphic, and held-out layers; track known failures
   explicitly and detect when they start passing. Missing required measurements must fail visibly.
   Changing a floor or dataset requires an explicit decision and a newly measured baseline.

7. **Treat negative results as conditional evidence.** Label smoothing improved confidence while
   harming tags; more FR order weight worsened postcode boundaries; broad country synthesis amplified
   false positives. These close specific recipes, not whole research directions. Span rescoring helped
   an earlier sparse gazetteer, then became inert after coverage improved. On July 13, fragment data
   improved the existing architecture despite a prediction that an architectural change was required.

8. **Audit corpus transformations against raw inputs and full relevant populations.** A builder and
   its audit shared punctuation normalization and missed the same bug. Source-ordered sampling
   falsely classified Paris as street-dominant. Use source/country-aware counts and known controls.
   Independent Arrow column chunks cannot safely be zipped as rows; use row-aligned batches.
   Normalize text and component values consistently before deriving offsets. The Bengali span incident
   was ultimately explained by NFC changing code-unit length, correcting an earlier `locateSpan` claim.
   Quarantine must retain reasons and counts; resumable builds must verify reusable artifacts.

9. **Match evidence to the claimed scope.** A region-limited OSM extract needs an in-region evaluation;
   an all-France sample hid an Île-de-France improvement. Japan's KEN_ALL construction-source result
   needed a GeoNames cross-check. Major-city lookup does not prove national address coverage. Competitor
   403/429 responses are failed measurements, not geocoding misses. OA-based competitor tests must
   disclose that a competitor may index the same source.

10. **Treat releases as a set of independently verified artifacts.** Model, tokenizer, auxiliary feature
    files, calibration, databases, package dependencies, npm, HF, and demo assets must agree. Verify
    clean installation and served bytes. Omitted workspaces and partial publication left inconsistent
    releases; an unpushed version change published old weights. Use the current release skill rather
    than historical commands or local publishing workarounds in the logs.

11. **Make autonomous work resumable and bounded.** Save evidence and decisions during the session;
    keep running scripts independent of branch switches and immutable while executing. Monitor actual
    checkpoint progress and spend, not merely process liveness or a stale rate field. Diagnose one
    variable per retry, stop repeated failures, and work independent tasks during compute waits.
    Reproduce stale issues before implementing them; verify delegated changes against their scope.
    Reversible preparation can proceed without inventing a new approval barrier.

## Final recorded stopping point

**Observed, July 13:** routing could not reliably distinguish fragments; street-morphology bias
regressed AU formats; bolt-on CRF transitions harmed parity at both tested scales. The subsequent
fragment-data assay improved street parity from approximately 0.40 to 0.53. Tokenizer consolidation
reduced diacritic fragmentation but introduced postcode and locality regressions, which later extract
variants addressed. The record's closing table supersedes its stale “zero models / $0 GPU” footer:
four training runs occurred, and total final spend is unknown.

**Decision at that cutoff:** v2.5.2 was not promotable because of the Dublin regression. v2.5.3 passed
the full Gauntlet but remained staged with per-locale F1 and error-analysis legs outstanding. Its parity
scores were house_number 0.7403, postcode 0.9861, and street 0.5233, against stated floors of 0.97,
0.97, and 0.90. A passing Gauntlet therefore did not establish the campaign's parity goal or release
readiness. The next proposed data change was deterministic locality counterexamples from the
gazetteer, rather than repeatedly patching sampled famous cities. Subsequent July records outside
the deleted directory own what happened next.

## Archive removal

This summary intentionally omits overnight schedules, merge queues, transient process IDs, stale
approval discussions, and superseded next-step lists. Detailed model, resolver, calibration, and
matching reports outside the source directory remain separate evidence; the pinned Git revision above
preserves the original narrative when an exact historical claim needs inspection.

Before removing the source directory, update its remaining incoming references. At consolidation time,
these included three release-history citations, links from the June 14 coarse-placer and June 22 day
retrospectives, and v4.11.0's `promotion_eval_doc` in the en-us model card. Preserve the model card's
promotion provenance through an archived receipt or a supported immutable reference. Do not replace
a specific promotion receipt with this retrospective or silently rewrite released metadata. The eval
index now points to this summary.
