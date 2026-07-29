# The from-scratch retrain × the enterprise fine-tune line — fit brief

**For:** the operator's "I'd like to see where it fits in our enterprise stuff" (2026-07-30).
**Context:** GTM task **B11** (enterprise fine-tune pipeline), the v8.2.0 arc's fine-tune-forgetting
receipts, and the parked CJK char-encoder decision gating the acquired JP/KR data.

## The one-sentence fit

The from-scratch retrain is not a competitor to the enterprise fine-tune product — it is its
**first deliverable**: the golden master every customer fine-tune starts from, the training run
where forgetting-protection gets built in at the only point it is cheap, and the base whose QA
harness becomes the per-customer acceptance battery.

## Why the enterprise line makes the retrain _more_ urgent, not less

1. **Every fine-tune inherits the base's debt.** The v8.2.0 arc measured this precisely: every
   fine-tune off v385 — bundle or not, either feed — pays ~−5pp on Canadian PO-box rows
   (fr.cedex 85.6→~80.5, replay-boost plateau ~83.4). That is _rare-class forgetting_, and it is
   structural to fine-tuning, not to our recipes. A customer fine-tuning on their address stock
   will hit the same class of erosion on whatever _their_ rare classes are — invisible until the
   right instrument reads it. If fine-tuning is the product, the base model's own debts (the cedex
   watch, the re-anchored floor, the Fifth-Ave fixture) should be zero at the starting line.

2. **Consolidation machinery is only cheap at base-train time.** EWC-style protection needs the
   base model's Fisher information over the base distribution. Computed during the from-scratch
   run, it is a side artifact (one extra pass, stored beside the checkpoint); retrofitted later, it
   is a separate expensive job against a distribution we no longer sample. If B11 ships, the
   Fisher diagonal becomes part of the _weights bundle contract_ — every customer fine-tune gets
   forgetting-protection against the base capabilities for free, and "your fine-tune cannot break
   core parsing" becomes a **sellable guarantee** instead of a hope. That artifact can only ride a
   from-scratch run.

3. **The QA harness is the acceptance battery.** The v8.2.0 arc built, run by run, exactly what a
   customer fine-tune needs at delivery: pre-registered gates, the ablated-vs-fed columns, canary
   fixtures with receipts, replay dosing, the misroute-cost measurement, the pre-ship gauntlet.
   Productizing B11 is largely _packaging this harness_ — per-customer canaries from their own
   golden rows, the same gate sheet, the same verdict discipline. The retrain is the first
   consumer of the packaged form (dogfooding the acceptance battery on our own base).

4. **CJK folds in here or waits another cycle.** The JP (Japan Post/GSI) + KR (juso, 6.17M) data
   is acquired and ready, gated on the one char-encoder decision (CharCNN front-end per the v8
   design notes). A char-encoder change is architecturally a from-scratch event — it cannot ride a
   fine-tune. For the enterprise line, JP/KR is market surface: validation/record-matching
   customers with East-Asian address stock are a distinct segment no drop-in competitor serves
   well in-process.

## What the retrain retires (the standing watches)

| Debt                                              | Today                                                                | After                                                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| fr.cedex forgetting + re-anchored floor (82.2)    | named watch, waived                                                  | re-learned natively; floor re-cut from the new base                                                 |
| Fifth-Ave / num-ordinal brittleness               | trained out in v3.24 + permanent gauntlet fixture                    | invariant trained from step 0 (augmentation in the base recipe)                                     |
| Fine-tune-of-fine-tune stacking (v385←v381←v310…) | four generations deep                                                | flattened; every capability from one recipe with one provenance                                     |
| Evidence bundle as a fine-tune graft              | channels added at 6k-step fine-tunes, over-trust curricula bolted on | channels + curricula in the base objective from step 0 (the over-trust pattern may not form at all) |
| Capability manifest / calibration drift           | carried-forward blocks, re-anchors                                   | regenerated from one run                                                                            |

## Sequencing recommendation

1. **Pre-work (no GPU, this week if desired):** the char-encoder decision memo (CharCNN vs
   byte-fallback status quo — the v8 design notes in the scratchpad archive carry the candidates);
   the base-recipe assembly (v385's feed + the bundle channels + all curricula + ordinal/directional
   augmentation + JP/KR shards behind the encoder decision); Fisher-capture design (~1 day of
   training-code work).
2. **The run itself:** materially bigger than the arc's fine-tunes (from-scratch, larger step
   budget, possibly the encoder change) — plan in agent-nights with the full G1–G7 ladder plus
   per-locale gates; the acceptance battery in its packaged form is the exit criterion.
3. **B11 alpha after:** the packaged battery + the Fisher-protected fine-tune recipe make the
   first enterprise fine-tune engagement mostly configuration, not research.

**Net:** if B11 is real, the retrain is its foundation work and should be scheduled as such —
"the release that makes fine-tuning safe to sell." If B11 stays parked, the retrain is still owed
(the watches above) but loses its urgency multiplier and can wait behind the GTM lane.
