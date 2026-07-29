# Road to Mailwoman v8.3.0 — the from-scratch retrain as the enterprise foundation

**Status:** 🟡 **PLANNING** · **Opened:** 2026-07-30 · **From:** 8.2.0 / bundle 6.7.0 / model
v3.24.0-bundle-ordinal (the first shipped evidence-bundle model) · **Authors:** Claude,
operator-directed.

**Directive (operator, 2026-07-30):** plan the from-scratch retrain **as the enterprise
foundation** — the base model the B11 fine-tune product starts every customer engagement from.
Full fit argument: `docs/superpowers/plans/2026-07-30-from-scratch-retrain-enterprise-fit.md`.
One sentence: the retrain is B11's first deliverable — the golden master, the training run where
forgetting-protection is captured at the only point it is cheap, and the base whose QA harness
becomes the per-customer acceptance battery.

Standing doctrine carried forward: coarse phases, no micro-gates unless genuinely confounded;
lowercase is the primary user register (every eval gets a lowercase leg); model-first — no new
decode-time flags ride this arc; the D-rule (iron rule 6) gates every cut.

---

## 1. What 8.2.0 leaves on the table (the debts this arc retires)

| Debt                                                    | Today                                                                | After the retrain                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| fr.cedex fine-tune forgetting + re-anchored floor       | named watch; floor waived at 82.2 (shipped-same-harness 85.6)        | re-learned natively; floor re-cut from the new base's own reading         |
| Fine-tune-of-fine-tune stacking (v3.24←v385←v381←v310…) | four generations deep; provenance smeared across recipes             | flattened — every capability from one recipe, one provenance              |
| Evidence bundle as a graft                              | channels + anti-over-trust curricula bolted on at 6k-step fine-tunes | channels + curricula in the base objective from step 0                    |
| Num-ordinal / directional invariants                    | trained in via late augmentation (v3.24) + gauntlet fixtures         | in the base recipe from step 0                                            |
| Calibration / capability-manifest drift                 | carried-forward blocks, environment re-anchors                       | regenerated from one run                                                  |
| DE country fold (the deliberately-deferred increment)   | locality lexicon is US+FR                                            | folded into the base lexicon build (one increment, gated like the others) |

## 2. The shape — two coordinated arcs, one release train

**Arc 1 — the Latin base retrain (this document's core).** From scratch on the assembled
production feed, the current SentencePiece tokenizer (v0.9.0-multisplice) unless §4 decides
otherwise, all shipped capabilities native. Produces the **model 7.0.0** weights bundle.

**Arc 2 — the CJK sibling model (epic #1176, the standing plan).** Per
`scratchpad/v8-cjk-architecture-plan.md` + `fable-v8-jp-char-encoder-design.md`: a char-level
(CharCNN — already committed and gated-off) **separate model**, script-routed at the runtime
layer. The Latin model is untouched by construction, which makes the Latin non-regression
**provable** (byte-identical routing), not measured. JP (then KR) data is acquired. The
single-model unification is explicitly deferred (v9-class).

Consequence worth stating plainly: **the Latin retrain does NOT carry the char-encoder decision.**
The two arcs share the release train and the acceptance battery, not an architecture gamble.
Whether Arc 2's first trained artifact ships _in_ 8.3.0 or the next minor is a cut-time scope
call, not a plan-time commitment.

## 3. The enterprise deliverables (what makes this "foundation" and not just hygiene)

1. **The golden master.** Model 7.0.0 with zero named watches at ship — the starting line every
   customer fine-tune inherits.
2. **Fisher capture** (the consolidation artifact). One extra pass during the base run stores the
   Fisher diagonal beside the checkpoint, making EWC-style protection available to every
   subsequent fine-tune — ours and customers'. Design note first (§6); the training-code delta is
   small, the contract addition ("the weights bundle ships its Fisher") is the real decision.
3. **The packaged acceptance battery.** The v8.2.0 arc's instruments — pre-registered gates,
   ablated-vs-fed columns, canary fixtures with receipts, replay dosing, the pre-ship gauntlet —
   formalized as a reusable battery (`mailwoman eval battery <config>`-shaped). The retrain is its
   first consumer; the first B11 engagement is its second.
4. **The fine-tune recipe template.** init_from 7.0.0 + Fisher penalty + replay defaults + the
   battery as exit criterion — the thing a customer engagement instantiates instead of researches.

## 4. Decision register (operator calls; nothing below launches until these are named)

| #   | Decision                       | Options / default leaning                                                                                                                                                                       |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Step budget + compute envelope | The v385 lineage totals ~40k+ steps across generations; a from-scratch base wants a real budget (agent-nights + GPU spend sized in the recipe memo, not guessed here)                           |
| D2  | Feed assembly                  | v385's feed + the bundle lexicons as baseline; each deploc passenger (gb/nz/es-pedania/fr-lieudit) + punct_drop 0.6 re-enters ONLY with its own promotion case; DE fold rides the lexicon build |
| D3  | Tokenizer                      | Keep v0.9.0-multisplice (default — comparability + the splice history) vs retrain SP (only with a named reason)                                                                                 |
| D4  | Fisher scope                   | Diagonal-only (default, cheap) vs blockwise; which distributions (the full feed vs per-locale slices)                                                                                           |
| D5  | Arc 2 in 8.3.0?                | JP-first sibling model in-scope vs next minor; the corpus BIO-alignment de-risk (the CJK plan's named long pole) decides                                                                        |
| D6  | Model/npm numbering            | Model 7.0.0 + npm 8.3.0 (default) — a from-scratch base is a model-major even when the API is additive                                                                                          |

## 5. The base recipe — known ingredients (assembly memo precedes launch)

Everything already proven, no research items: the v385 feed (v0.13.0-latam) + evidence channels
(street_type/locality_surface) painted from the digit-guarded four-law lexicons (street v3 /
locality-surface v6 + the DE fold → v7) + absence & false-evidence curricula + ordinal/directional/
region/glue/case/punct-drop augmentation (punct_drop level per D2) + the anchor/gazetteer/country
channels as shipped. The recipe memo assembles these with citations to each ingredient's receipt
and pre-registers the full gate sheet before any GPU spend.

## 6. Fisher / consolidation work item

Design note → capture implementation (training-side, ~days) → bundle-contract addition (the
Fisher artifact beside model.onnx, versioned like the lexicons) → the fine-tune recipe consumes it
(EWC penalty, λ calibrated once on our own next fine-tune) → the **guarantee gate**: a
Fisher-protected fine-tune must hold every base capability within noise on the battery. That gate
is the sellable sentence in B11.

## 7. Gates for the cut (pre-registered in the recipe memo, sketched here)

- The full G1–G7 ladder as evolved through v3.19→v3.24 (fragment bars incl. lowercase legs,
  ablation vs the 6.7.0 reference, invariance vs 6.7.0, gauntlet, golden ablated ALL floors with
  freshly-cut noise-honest margins, canary zero-flip, the pre-ship gauntlet on the flip).
- **Match-or-beat 6.7.0 everywhere** (the D-rule with no waivers — the entire point of the
  from-scratch is zero named watches at ship), including fr.cedex against the _original_ 85.6-class
  reading, not the waived floor.
- Per-locale full family (the Latin 23) + the demo smoke + the browser runner path.
- If Arc 2 ships: the script-router's provable Latin byte-identity + the JP gates from the CJK
  plan's own pre-registration.

## 8. Sequencing (coarse phases)

1. **Phase 0 — memos (no GPU):** the recipe-assembly memo (D1–D4 resolved, gates pre-registered);
   the Fisher design note; the CJK BIO-alignment de-risk spike (D5's input). Each ends in an
   operator sign-off, then hands are free.
2. **Phase 1 — Fisher capture implementation + battery packaging** (code, testable without the big
   run; the battery packaging is B11 work product regardless).
3. **Phase 2 — the run + the ladder** (the big spend; one run, the stop rules travel with it).
4. **Phase 3 — ship** (the 8.2.0 cut choreography, now twice-rehearsed: card/HF/R2/prepare/publish/
   demo) **+ B11 alpha** (the fine-tune recipe template exercised once on a synthetic "customer"
   shard as the dress rehearsal).

## 9. Open questions (beyond the register)

- Does the battery packaging live in-repo (`mailwoman eval battery`) or start as the runbook it
  already is? (Leaning: runbook first, CLI when the second consumer exists.)
- Per-customer canary methodology for B11 — who writes the customer's golden rows, and what is the
  minimum n for the noise-honest margins we now compute routinely?
- Where the Fisher artifact meets Trusted Publishing / HF staging (one more preflight file, same
  pattern — mechanical, but named so it isn't forgotten at the cut).
