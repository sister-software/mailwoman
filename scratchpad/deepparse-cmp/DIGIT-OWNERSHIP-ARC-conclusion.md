# Digit-ownership arc — CONCLUSION (fully explored)

The operator asked to explore this fully. Done. Every lever is measured; the ceiling is known.

## The corpus lever's ceiling: bare-street-hn ~0.77, clean

| model                               |  bare-street-hn | FR fragment | golden gate                    | verdict               |
| ----------------------------------- | --------------: | ----------: | ------------------------------ | --------------------- |
| v310 (shipped v6.4.0)               |           0.693 |       0.733 | PASS                           | baseline              |
| numsplice v354 (vocab, 8k)          |  ~0.82 (CLEARS) |           — | **FAIL: 5 tags >2pp down**     | bad trade, DON'T ship |
| knob 1 (bare-street↑)               |    0.695 (flat) |      −1.5pp | —                              | falsified             |
| knob 3 (≥3-digit ×4, 8k)            | 0.733 (plateau) |      +2.5pp | PASS 0 reg                     | additive, below bar   |
| **tweak (all-length ×6)** 2k        |       **0.775** |      +5.4pp | PASS 0 reg                     | best 2k               |
| **tweak (all-length ×6) 8k (v373)** |       **0.767** |      +2.9pp | **PASS 0 reg, +2.3 homograph** | **ceiling, clean**    |

The all-length boost broke knob 3's 0.733 plateau to ~0.77, and it holds there through 8k (2k 0.775 →
8k 0.767, converged). That is the CEILING of the clean corpus lever: **bare-street-hn +7–8pp over shipped,
FR fragment +3pp, country_homograph +2.3pp, zero golden cost.**

## The strict bar is not met — and now we know why it can't be, cleanly

The pre-registered bar wanted bare-street-hn's lower CI above v310's upper CI (0.736), ~≥0.78. v373 is
0.767 [0.724, 0.806] — point estimate at the target, lower CI just under. It plateaus below the bar. The
residual is the digit→postcode length prior on 3–4 digit numbers (v371's breakdown: 3-digit was still
0.66-fail even under boost). Only vocab surgery (numsplice) moved that mode on-board — and numsplice fails
the golden gate. So: **the bar-clearing option carries an unacceptable trade; the clean option tops out at
~0.77.** ~0.77 clean IS the answer to "how far does this go without breaking anything."

## Ship / hold

**v373 is a clean, strong net-positive over shipped v6.4.0:** bare-street-hn +7.4pp, FR fragment +2.9pp,
country_homograph +2.3pp, and NOTHING regressed >2pp on the golden gate (fr.house_number +0.1). It is
strictly better on every axis it touches, with no trade — the opposite of numsplice.

1. **SHIP v373** — the best model the arc produced. Honest framing: it improves the digit-ownership target
   materially (+7–8pp) and several other things, at zero cost, but does not formally clear the arc's bar
   (the bar needed a trade nothing clean can pay). A defensible release: a clean net-positive.
2. **HOLD** — bank v373, keep v6.4.0, and bundle the no-fragment shard (all-length boost 6, the recipe is
   committed) into the next model change rather than spending a release on +7pp-target/+3pp-FR alone.

Recommendation: **ship v373** if a release slot is cheap — it's a clean, real improvement with a
cross-lingual bonus (FR + homograph) and no downside. Hold only if batching releases. The digit-ownership
defect is now fully characterized: clean ceiling ~0.77, bar-clearing requires a trade we won't pay.
Promotion is the operator's act. Artifact: `./out/v373/model.onnx`, tokenizer v0.9.0-multisplice (shipped),
recipe `no-fragment` with `--long-number-boost 6 --long-number-min-digits 1`.
