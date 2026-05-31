# The harness is v0's home turf — reframing the scoreboard (2026-05-30)

**TL;DR.** The 415-assertion `harness-v0-neural` suite — our de-facto neural
"promote bar" — is a **port of the Pelias parser + addressit corpora**, the same
lineage the `v0` rule parser was built from. v0 scores 93.7% on it almost
tautologically; the neural model scores 19.8%. Chasing a 25% neural score on a
suite where neural is structurally disadvantaged is the wrong hill. The
**resolver end-to-end metric** (address to correct WOF place) is the honest
scoreboard, and there the same v0.7.2 model already **wins**: neural 68.9% vs
v0-via-adapter 63.7% Place-Match Acc@1. This doc records the evidence (all numbers
re-verified from clean runs) and proposes the metric reframe.

## The numbers (v0.7.2, deterministic re-run, 2026-05-30)

`scripts/harness-v0-neural.ts --tests mailwoman/test --falsehoods
data/eval/falsehoods --postcode-repair` against the v0.7.2 model
(`output-v072-intersection`, tokenizer `v0.6.0-a0`):

| Parser | Pass | Rate |
| --- | --: | --: |
| v0 (rule-based) | 389 / 415 | **93.7%** |
| Neural (fp32) | 82 / 415 | 19.8% |
| Neural tree structurally valid (#37) | 391 / 415 | 94.2% |

Outcome cross-tab (sums to 415, the integrity check):

| Category | Count |
| --- | --: |
| Both pass | 72 |
| **v0 only** | **317** |
| Neural only | 10 |
| Both fail | 16 |

Read the two rows that matter together: **v0-only is 317, both-fail is 16.** Of
the 333 cases neural fails, **317 (95%) are cases v0 handles fine.** Only 16 are
hard for both parsers. The neural model is not failing on intrinsically hard
addresses — it is failing on addresses that are easy *for a rule parser tuned on
this exact corpus*.

## Why that is expected, not alarming

`data/eval/external/README.md` already documented the lineage problem for the
external arenas; it applies to the harness itself. The `mailwoman/test/*.test.ts`
files the harness extracts `assert(input, ...expected)` calls from are, on
inspection, a **port of Pelias parser + addressit** — and our v0 parser is itself
Pelias-derived. So:

- The expected labels encode Pelias/addressit's *segmentation conventions*.
- v0 reproduces them by construction, hence 93.7%.
- The neural model learned a *different* (often defensible) segmentation and is
  graded as wrong whenever it disagrees with the Pelias convention.

The matcher is already lenient — `expectedMatchesActual` passes on substring
containment in **either** direction (`harness-v0-neural.ts`) — so pure over- or
under-span boundary errors do **not** cause failures. The failures that remain are
genuine *disagreements*: a tag the model did not emit, or a value that is neither
equal to nor a substring of the Pelias-expected value.

### The dominant failure shape: under-segmentation on non-canonical input

Spot-checking the failing cases (the dominant pattern across the 317 v0-only
wins): the model **collapses adjacent fields** on inputs that drift from the
clean, comma-delimited US training distribution. Representative real failures:

- `6000, NSW, Australia` — expected postcode/region/country; neural tagged `6000`
  as house_number and `NSW` as locality (AU postcode-leading line).
- `Unit 12/345 Main St` — expected unit_designator/unit/house_number/street;
  neural produced street `Unit 12`, locality `Main St` (AU unit-slash format).
- `U 12 345 Main St` — neural produced only locality `U`, postcode `12`.

The pattern is consistent: when the surface form drifts from the canonical
comma-delimited US template, the segmentation degrades — the model leans on
delimiter/format cues it saw in training rather than on token semantics.

## The honest scoreboard: resolver end-to-end

The product goal is *address to correct place plus coordinates*, not *match
Pelias's component spans*. The Direction-C resolver eval
(`scripts/eval/resolver-eval.ts`, 2406 WOF-bootstrap rows, custom gazetteer)
measures that directly. Numbers below were re-verified two ways: the script's own
output and an independent recompute from the raw per-row sidecar — they agree to
the decimal.

| baseline | canonical | perturbed | all |
| --- | --: | --: | --: |
| neural-only | 77.1% | 64.8% | **68.9%** |
| v0-via-adapter | 69.5% | 60.8% | 63.7% |
| arbiter (pick higher resolver score) | 76.9% | 69.5% | 72.0% |
| oracle (either correct) | 79.4% | 77.1% | 77.9% |

On the metric that matches the product, **the neural model already beats v0**
(+5.2pp Acc@1 overall), and the old "route clean inputs to v0" thesis is dead —
neural wins clean too (77.1 vs 69.5). The arbiter (dual-parse, pick the
higher-resolver-confidence result) adds **+3.1pp overall and +4.7pp on
perturbed/noisy input** over the best single parser. Coordinate error is p50 0 km
/ p90 1090 km for neural-only (all 2406 rows resolved).

## Reframe (the proposal)

1. **Resolver end-to-end Acc@1 is the headline metric.** It matches the product,
   is lineage-neutral, and is where the model's value actually shows.
2. **The `harness-v0-neural` suite is a regression gate, not a promotion bar.**
   Keep running it — a *drop* signals a real regression — but stop treating "25%
   neural on a v0-lineage suite" as the goal. It asks the neural model to imitate
   Pelias's conventions on Pelias's own corpus.
3. **Coverage, measured on lineage-neutral sets, is the lever.** The
   under-segmentation on non-canonical formats (above) is the real gap, and it
   shows up on the *perturbed* resolver subset and the external arenas — both
   lineage-neutral — not just the Pelias harness.

This reframe unblocks two stalled cycles (v0.6.x held after three recipe
iterations; v0.7.x calibration null on the harness): both were optimizing a
lineage-biased metric. It is consistent with the v0.7.2 eval's own conclusion
("the path to 25% is coverage and the resolver, not another recipe tweak") and
with `project-neural-vs-v0-capability-map`.

## Next model experiment (one pre-registered hypothesis)

Continue-train from the v0.7.2 checkpoint with **interleaved comma-free renders**
(`house street locality region` with the delimiter dropped), roughly 15% of
batches, low LR, capped steps, early-stop on the harness, with a held-out
comma'd-only forgetting tripwire. Hypothesis: the model leans on a comma cue that
real inputs drop (`339 Bedford Ave Brooklyn`); teaching delimiter-invariance
should move locality-missing and street-absorbs-locality together. Pre-registered
revert: if post-train harness is below 22% **and** resolver Acc@1 does not improve
by at least 1.5pp, revert — the lineage-mismatch conclusion stands.

## Provenance note

These numbers were produced during a session in which the local tool-output
display layer had earlier been corrupting/duplicating command output. After the
environment was restarted and verified clean (a fixed string hashed repeatedly
returned a stable digest; a 17-command parallel batch ran with no cancellations),
**both evals were re-run from scratch.** The harness cross-tab sums to 415, and
the resolver table reproduces from an independent recompute of the raw sidecar —
the figures here are trustworthy. Per-case forensic breakdowns that could not be
cross-checked are deliberately omitted rather than reported at false precision.
