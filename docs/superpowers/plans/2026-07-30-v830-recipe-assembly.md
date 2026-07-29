# v8.3.0 Phase-0 memo 1 — the Latin base recipe assembly (D1–D3 evidence)

**Resolves:** ROAD_TO_MAILWOMAN_V8_3_0 §4 decisions D1 (budget), D2 (feed), D3 (tokenizer).
**Rule:** nothing here launches; this memo + operator sign-off on the three decisions do.

## D1 — step budget + compute envelope

Receipts. The shipped lineage's training totals: the v264-era base trained 40–100k-step runs;
every arc since has been an 8k-step fine-tune (~35 min A100 at ~4.3 steps/s). A from-scratch base
at the current geometry (~29M params, 128 seq) with the full feed:

- **Proposed: 60k steps, cosine anneal, one seed** (s42), checkpoints every 5k, the over-trust
  watch grading every save from 40k on (the 6k-peak/8k-decay pattern was a _fine-tune constant-LR_
  artifact; a from-scratch anneal changes the dynamics — the ladder decides empirically).
- Wall-clock ≈ 4 A100-hours for the run itself. The honest budget is the _ladder_, not the run:
  per-save P0 grids + exports + the local golden battery ≈ 1 agent-night per candidate window.
- **Envelope: 2 runs maximum before a stop-and-report** (the arc discipline: one pre-registered
  run; one contingency re-run for a named, single-delta fix; a third attempt is an operator
  conversation). Total ≈ 10 A100-hours + 2–3 agent-nights.

## D2 — feed assembly

Baseline = **v385's feed verbatim** (`v0.13.0-latam`, its source weights, its augment probs) —
the composition every golden floor was cut against — **plus**:

| Addition                                                       | Status                                                                     | Case                                                                                                                                                                |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evidence-channel painting (street v3 / locality-surface v6→v7) | street proven; locality UNTRAINED-TO-DATE (#1349 — see the addendum below) | the bundle native from step 0                                                                                                                                       |
| Ordinal-street augmentation 0.3                                | proven (v3.24)                                                             | the num-ordinal invariant                                                                                                                                           |
| Absence + false-evidence curricula                             | proven                                                                     | anti-over-trust, from step 0                                                                                                                                        |
| DE country fold → locality lexicon **v7**                      | new increment                                                              | the deliberately-deferred fold; built + gated exactly like v5/v6 (four laws + digit guard; DE has 67k neighbourhoods — the parent-vouch path gets its third locale) |
| synth-po-box-cedex at the **v385 share** (1.5)                 | reverts the replay boost                                                   | from-scratch re-learns the class natively; the boost was fine-tune medicine                                                                                         |

**Deploc passengers stay out** (synth-gb 10.0 / nz / es-pedania / fr-lieudit, punct_drop 0.6).
Each re-enters only with its own promotion case — the v3.22 feed attribution is the receipt
(GB street-boundary transfer, CA po-box dilution). The fragment classes those shards fed are
covered by the bundle channels now; if a G1 bare-locality bar misses, es-pedania/fr-lieudit are
the named first re-entrants (the v3.22 pre-registration's own contingency).

### Addendum 2026-07-29 — the #1349 reframe (locality channel never trained)

Found after this memo merged: `_to_tensor_batch` never converted the locality_surface tensors, so
**every bundle-era run (v3.16 → the shipped v3.24) trained the locality channel on zeros** — the
shipped projection is frozen at xavier init (receipts on #1349: token embedding exactly 0/384;
projection absmax = the xavier bound). The trainer fix + a structural key-parity test landed in
#1350. What this changes here:

- **The locality channel's receipts are re-attributed, not voided.** The measured behavior
  (v3.16 damage classes, the fed-register heals) came from a CONSISTENT RANDOM MARKER — real
  painted features through a frozen random projection. Per-channel ablation on the shipped
  checkpoint: locality-fed is −0.058 net in asis but **+0.035 net in the lowercase user register
  (homonym +0.270)** — the marker's existence helps where the case cue is dead; prod's
  street-context gate masks most of the asis damage (bare-locality −0.355 ungated).
- **The three-law selectivity receipts survive as PAINTING HYGIENE** (they made a blind marker
  net-positive by restricting it to discriminative hits), not as evidence of trained-channel
  behavior. Keep the laws in the v7 lexicon build unchanged.
- **This run is the locality channel's FIRST actual training.** Pre-registered expectations must
  not cite the fine-tune heals as trained-channel evidence. Floor: the trained channel must beat
  the accidental marker's own readings (homonym-lower +0.270 fed-vs-zeroed is the number to beat);
  target: the bare-locality damage class (the marker's cost) goes to ~0 under the now-actually-
  reaching-the-channel absence/false-evidence curricula.
- **Risk note for G-gates:** the shipped reference (6.7.0) carries the marker's lowercase homonym
  behavior; a properly-trained channel plausibly clears it, but if the homonym-lower bar sits
  exactly at the marker's accidental gain, read the miss against THIS addendum before iterating.

## D3 — tokenizer

**Keep `v0.9.0-multisplice`.** Reasons: (a) every gate reference, calibration, and fixture in the
battery assumes it — retraining SP invalidates the F1 comparability the whole verdict rests on
(the eval-protocol rule: never compare F1 across tokenizer versions); (b) the #825 postmortem
shows SP-vocab changes are their own arc with their own failure modes; (c) CJK does not need it —
Arc 2's char path bypasses SP entirely. A tokenizer retrain is a v9-class decision that would ride
the unification question, not this base.

## The pre-registered gate sheet (sketch → finalized in the launch config header)

1. **G1–G7 as evolved through v3.19→v3.24** (fragment bars with lowercase legs; ablation vs the
   6.7.0 same-grader reference; invariance vs 6.7.0 int8; gauntlet ×3; golden-ablated; canary;
   the pre-ship gauntlet on the dev-linked flip).
2. **Match-or-beat 6.7.0 with zero waivers** — including fr.cedex against the 85.6-class reading
   (the unwaived shipped-same-harness number), the entire point of from-scratch. All golden floors
   re-cut noise-honest (max(1.0pp, 2×SE) at each metric's support) from the candidate's own
   readings at promote, per the v6.0.0 spec's philosophy.
3. **DE gates** (new): DE golden legs at the current de.native_locality floor + a DE fragment leg
   in the P0-style board (the lexicon fold must show a win or stay out — same D-rule as every
   lexicon generation).
4. **Fisher side-artifact sanity** (memo 2): capture completes, artifact loads, the penalty
   reproduces a null fine-tune (λ→∞ freezes, λ=0 matches unprotected) — mechanical checks, not
   quality gates.
