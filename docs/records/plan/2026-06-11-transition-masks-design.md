# Per-system transition masks — design note (#478 slice 3, not yet built)

Status: DESIGN ONLY (night-11). Slice 1 (emission mask, v4.3.0) and the span bridge (v4.4.0
corrective) shipped; the train-time loss-mask pairing is implemented and banked
(`use_conventions_loss_mask`, probe deferred by consult — rides the next full run). Transition
masks are the next decode-side slice, recorded here with their failure mode BEFORE anyone
implements them in a hurry.

## The idea

The conventions table grows a `forbiddenTransitions` field: ordered label pairs that are
ungrammatical in a detected system, applied as additive `-1e9` entries to the Viterbi transition
matrix (which is structural-BIO-only today). Candidate first rows, each with measured motivation:

- `fr`/`de`: `I-postcode → B-street` and `I-postcode → B-house_number` — the digit-split family
  (a 5-digit-system postcode never hands off mid-number; both systems' shapes are `^\d{5}$`).
- Universal candidate (needs care): `B-postcode → B-postcode` within three chars — the
  double-postcode emission the comma-bridge incident exposed (the model double-labels a
  following house number as a second postcode fragment).

## The pre-registered failure mode (DeepSeek, 2026-06-10 — the one keeper from that consult)

Banning `I-postcode → B-street` does not make the orphan digit correct — it forces the
probability somewhere, and the most likely refuge is `I-postcode`: the digit gets ABSORBED INTO
the postcode, corrupting it worse than the split did ("4711" + street "0 …" at least kept four
correct digits; "47110…" absorbing a house number corrupts the field outright). Any transition-
mask implementation must ship with this as a regression TEST CASE: the FR digit-split rows +
the glue rows, asserted not-worse under the mask.

## Why it is NOT being built tonight

1. The motivating classes are now covered upstream: the digit-split died with the #511 relabel
   (in-weights, measured 6→2 FR misses with no mask), and the glue class died with the #513
   augmentation (arena floor 71 restored). A mask with no live failing class has no read.
2. The double-postcode emission is real (the comma-bridge incident) but is better attacked at
   its source first — it is a training-distribution question (why does the model double-label?)
   before it is a decode-constraint question.
3. Slice discipline: each conventions slice shipped against a measured failure. This one
   currently has none. The design waits for its evidence, like the `de` emission row waits for
   the leakage audit's class to grow past ~1%.

## When to revisit

- A gate FAIL whose row characterization shows an ORDERING error (not a span/boundary error)
  in a conventioned system.
- The double-postcode class surviving the next corpus pass.
- The `de` conventions row shipping (its postcode shape + the transition pair come as a unit).
