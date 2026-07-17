# B4b knob 1 (bare-street ratio 0.30→0.70) — FALSIFIED, and it revealed the target is dual-mode

**The pre-registered bar (v3.6.0 config):** board-3 bare-street-hn clears the bar v3.3.0 missed — lower CI
above v310's upper CI (0.736), i.e. ~≥0.78. Falsifier stated: "if 0.70 still does not clear, the corpus
lever is refuted for this defect." **It did not clear. Refuted.**

## The reads

| board 3                     |  v310 | v3.3.0 (prob 0.30) | v3.6.0 (prob 0.70) |
| --------------------------- | ----: | -----------------: | -----------------: |
| **bare-street-hn** (TARGET) | 0.693 |     0.710 (+1.7pp) | **0.695 (+0.2pp)** |
| bare-pc (guard)             | 1.000 |              1.000 |            1.000 ✓ |
| city-first-hn               | 0.953 |                  — |              0.953 |
| pc-first-hn                 | 0.940 |                  — |              0.945 |
| street-led-hn               | 0.968 |                  — |              0.965 |

**More bare-street signal moved the target LESS** than v3.3.0's lower ratio (+0.2 vs +1.7pp, both inside
v310's CI). And the FR guard re-drifted: FR fragment OVERALL 0.733→0.718 (−1.5pp), FR bare-street
0.715→0.677 (−3.8pp) — the same weight-dilution v3.3.0 showed. Both the primary AND the guard failed.

## Why — the target is DUAL-MODE, and bare-street worsens one mode

All 122 bare-street-hn misses are `house_number MISSING`, in two distinct modes:

1. **digit → postcode** (`Nordtømmesvegen 178` → postcode 178; `Leppdalsvegen 1285` → postcode). The
   tokenizer length prior — numsplice's target. Unchanged by this shard.
2. **number absorbed into street** (`Øvre Botilrudveien 2`: v310 split it CORRECTLY as house_number 2;
   **v360 now swallows the 2 into the street span** `street:"Øvre Botilrudveien 2"`). This shard CAUSED
   this regression.

Mode 2 is iatrogenic: the recipe docstring warned it (line 23 — "teaching bare `{street}` alone lets the
model satisfy every row by flipping its default"). Raising bare-street-prob to 0.70 cut the street+number
rows from 70%→21% of the shard; those are the rows that teach "a trailing number after a street is a
house_number." Starve them and the model learns streets don't carry numbers → it absorbs the number into
the street. The direction was backwards: the target needs MORE street+number signal, not less.

## The full digit-ownership picture — no lever clears the bar

| lever                     | on-board (bare-street-hn) | cost                                                                                   |
| ------------------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| B4c numsplice, all ranges | +9.7 to +13.2pp (CLEARS)  | golden gate: 5 tags >2pp down (fr-hn, unit, homograph, cedex, robustness) — DON'T SHIP |
| B4b corpus, prob 0.30     | +1.7pp (misses bar)       | FR −1.7pp                                                                              |
| B4b corpus, prob 0.70     | +0.2pp (misses bar)       | FR −1.5pp, + street-absorption regression                                              |

- **numsplice** clears on-board but fails the golden gate (diffuse cost — closed, `NUMSPLICE-8k-verdict.md`).
- **corpus** doesn't clear on-board at either ratio, and re-drifts FR both times.

## Fork

One corpus knob remains untested — **knob 3: oversample street + LONG-number rows** (`Leppdalsvegen 1285`
→ house_number). It is the mechanistically-correct direction (the opposite of knob 1): it directly
teaches the street/number boundary, attacking BOTH the absorption mode and (uphill against the length
prior) the digit→postcode mode. v3.3.0's +1.7pp at the higher street-hn ratio is a faint hint it helps.
BUT it fights the same tokenizer length prior that only numsplice fixed at root — and numsplice's root fix
failed the golden gate.

1. **CLOSE digit-ownership** (recommended). numsplice is a bad trade at every range; the corpus lever is
   refuted at two ratios and re-drifts FR. The defect is real but NARROW — bare street+number with no
   city/postcode context (an autocomplete fragment). Every lever tried is either ineffective or an
   unacceptable trade. Treadmill guard: two opposite-direction corpus outcomes on the same target → fork,
   not a third solo spin.
2. **One more probe: knob 3** (long-number oversample). The last untested corpus variant, mechanistically
   right, but faces the length-prior headwind numsplice needed vocab surgery to overcome. If it too misses
   the bar, digit-ownership is exhaustively closed.

Not spinning knob 3 solo (treadmill guard). Operator's call.
