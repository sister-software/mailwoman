---
title: Night-3 postmortem (2026-07-15) — the v7 direction, ratified and instrumented
---

# Night 3 (2026-07-15, 05:45–15:00 UTC) — direction ratified, heal shipped, stage-2 scoped

Conn taken after the operator's day conversation converged the v7 architecture question. **Zero
GPU, zero Modal spend, zero training runs.** Six PRs, all measurements on the shipped v264 weights.

## What shipped (PRs, in merge order)

The stack matters — #1136 and #1137 are based on #1132, not `main`.

1. **[#1132] `fix(neural)`: word-consistency heal → ship default-ON.** The 2026-06-19 gate shelved
   this heal (street −12.6 adversarial) and blamed "the vote amplifies noise on byte-soup rows,"
   naming a confidence-gated variant as the fix. That diagnosis was wrong. The regression was **two
   bugs in the heal**: (a) it re-decoded words whose pieces already _agreed_, overriding viterbi
   (`▁Broadway` B-street→O; all-street `Gamle`→locality) — the docstring had always promised
   agree⇒byte-identical, but the code only honored it when the vote happened to concur; (b)
   punctuation continuation pieces joined the preceding word's vote group (`Ave`+`,`), and their `O`
   mass manufactured fake disagreements that killed real spans (the whole ordinal-street class,
   `1st Ave, ND`). Fixed structurally + `splitOnPunctuation`, and the heal is a clean win with **no
   confidence floor** — the hypothesized floor measured _net-negative_ and ships unused.
2. **[#1136] `feat(evals)`: `mailwoman eval oracle-k`** — the k-best instrument (stacked on #1132).
3. **[#1133] `feat(resolver)`: plausibility guard** — lifted off the night-2 hybrid branch and
   reframed direction-agnostic; explicitly _not_ a rules-fallback trigger.
4. **[#1134] `docs`: the #727 stage-2 k-best plan** — the operator-ratified direction.
5. **[#1135] `docs(evals)`: 52 v1 schemes rescued** before the excision deletes them.
6. **[#1137] `docs(evals)`: PT/RO splice — falsified, fix mechanism confirmed** (stacked on #1132).

### The heal's numbers (v264, all instruments)

| instrument                   | off   | on (ship) |
| ---------------------------- | ----- | --------- |
| golden us street F1          | 82.0  | 82.2      |
| golden fr macro F1           | 42.2  | **51.5**  |
| golden adversarial street F1 | 85.7  | 85.7      |
| parity house_number          | 0.767 | **0.808** |
| parity postcode              | 0.972 | **0.986** |
| parity street                | 0.543 | **0.573** |
| golden exact-match           | 24.5% | 25.5%     |

2pp promote gate PASS (worst: country −0.4pp, n=245). Presets 6/6, zero grouper-audit. Gate
revision declared explicitly: `eval parity` now grades the ship-config parse; floors untouched.

## What we learned (the measurements that change the plan)

- **The failure partition overturns the boundary narrative.** 66% of parity street failures are
  **bare fragments with no house number** — a recall/polarity failure (26/34 empty-street rows have
  _zero_ street-family label in the raw argmax; the model refuses, the decode doesn't drop it).
  Leading-number inputs fail only 21.6%.
- **The digit-atomicity splice is counter-evidenced, not just unvalidated.** Multi-digit house
  numbers are the _best_-performing form (17.3% fail) vs short-digit 29.2% and alphanumeric 73.3%.
  Per-digit shattering does not correlate with failure. Deprioritized in the runbook.
- **Diacritics: "visibility, not regression" — confirmed.** Resolve-locality is 100% on every
  scored diacritic locale (CZ/PL/PT/RO/SK) while street-tag surface exactness lags. The city never
  goes wrong.
- **The stage-2 falsifier resolved both branches** (DeepSeek-designed, session 019f6471, zero
  training): naive segment re-decode over current emissions is _worse_ at rank 1 (0.453 vs 0.584) —
  a **trained** span scorer is necessary, decode hardening alone is falsified — while oracle@10
  street = **0.749**, +17.6pt of measured k-best rerank headroom.
- **PT/RO splice falsified at the data level, no GPU.** OA PT text is **100% uppercase**
  (188,430/188,430) so every spliced piece is uppercase and can never match title-cased production
  input; OA RO is **diacritic-stripped** (43/149,858 rows, none with `ț`/`ș`). The fix —
  re-sourcing from WOF native names — is mechanism-confirmed (`en|<0xC8>|<0x9B>|ei` → `en|ței`) and
  staged as v267, but it fixed 2 / **broke 1** (a Brazilian row) and widens overlap to fr/it/pl, so
  it needs a fresh multi-leg pre-registration rather than a shift-boundary rush.

## What went well

- **Re-litigating scar tissue paid immediately.** Two shelved verdicts were re-opened by checking
  their conditions instead of citing them: the word-consistency shelving (wrong diagnosis → a
  shipped win, no GPU) and the token-CRF divergence (bf16, token-level — conditions don't hold at
  segment granularity in fp32). The operator's own memory says scar tissue is conditional; tonight
  is the receipt.
- **Diagnostic-before-fix, twice.** The failure partition killed the digit-splice before it cost a
  run; the source-data check killed the OA splice before it cost a gate battery.
- **The #900 splice gate did its job** — it fired on codepoint overlap _before_ grading, which is
  the whole reason it exists.
- **Verification caught two would-be false claims.** An "ASCII row broke" reading that would have
  contradicted the byte-identity guarantee was a `--failing 50` **truncation artifact**; and the
  all-zero resolve column in the first diacritic probe was my own harness bug (`resolve` vs
  `resolveTree`), not a model finding.

## What could have gone better

- **Three commits failed silently, and my first diagnosis of _why_ was also wrong.** `git commit …
| tail -1` hid the failures, and I twice blamed an oxfmt crash. The real cause, found only when I
  stopped working around it and read the full hook output: **the pre-commit hook runs the compiled
  CLI (`mailwoman/out/cli.js`), and `out/` was stale from another branch.** Committing on a
  `main`-based branch while `out/` held the heal branch's build made the hook import a symbol
  `core/pipeline` doesn't export on `main` — so every commit on a freshly-checked-out branch died
  until `out/` was rebuilt. This is the known stale-`out/`-when-branch-hopping scar wearing a
  disguise, and the disguise worked twice. The pre-registration commit is the casualty: it was
  supposed to land _before_ grading and didn't; the gate-spec doc states that sequencing rather
  than claiming an ordering git can't show. **Lessons: verify the commit landed (`git log -1`) —
  never trust the tail of a pipe; and when a workaround succeeds twice, that's the signal to
  diagnose, not to keep working around.**
- **I wrote the PT/RO gate spec before checking the source data.** The 15 minutes that would have
  gone into `head -3 countrywide.csv` would have retargeted the whole task. Pre-registration is not
  a substitute for looking at the inputs.
- **Two PRs get no CI and I only noticed at the end.** `test.yml` triggers on
  `pull_request: branches: [main]`; a stacked PR targeting another branch is silently untested.
  Both are annotated with local evidence (3450 tests pass) and a merge-order warning.

## Decisions made autonomously

- **Shipped the heal default-ON rather than opt-in.** It's a decode-side library change with a
  clean sweep across every instrument; the alternative (ship opt-in, defer) would leave a measured
  win unshipped for no reason. Production parse behavior changes, so it's called out first in the
  handoff.
- **Declared the parity gate revision explicitly** (grade the ship-config parse) instead of leaving
  the gate measuring a parse production no longer performs. Floors untouched; `--no-word-consistency`
  preserves the old baseline. Per the no-silent-gate-drift rule, this is stated, not slipped in.
- **Did NOT ship v267.** It fixes both target rows and breaks a Brazilian one, and its overlap
  surface now includes FR — the exact locale of the v5.1.0 "net-positive by luck" incident. A
  six-leg battery finished near the shift boundary with the operator asleep is the artifact I'd be
  least comfortable defending. Staged and characterized instead.
- **Reframed rather than deleted the plausibility guard.** The code is sound and direction-agnostic;
  only its docstring assumed the rules-fallback that the operator ruled out.

## Open questions for the operator

1. **Merge order** — #1132 first (the stack base), then #1136/#1137 rebase to `main` and get real
   CI. #1133/#1134/#1135 are independent.
2. **Ratify the protected lane** for the span-head arc (plan item 4). It spans multiple nights; the
   nightly cadence is precisely what has kept it unbuilt for ~200 model versions.
3. **v267 disposition** — worth a proper multi-leg pre-registration (incl. a pt-BR leg), or park it?
   The RO byte-fallback fix is real (4/5 → 5/5) but the corpus exposure is 13/321 fixtures.
4. **Gate-inventory gap, independent of v267**: `pt-BR` / OA `br` should join the standing
   `--trained-samples` list — the overlap gate currently cannot see Brazilian Portuguese.

## Next steps

- Merge #1132 → rebase #1136/#1137 → confirm CI.
- Plan item 4: the span-head arc (`docs/superpowers/plans/2026-07-15-727-stage2-kbest-plan.md`) —
  kind-posterior soft channel + recall-weighted street loss (option C) _with_ the span head; fp32
  partition math; k-best decode mirroring `mailwoman/eval-harness/oracle-k.ts`.
- Wire the resolver rerank behind a flag; the plausibility guard becomes its first feature.

## Numbers

|                            |                                                |
| -------------------------- | ---------------------------------------------- |
| Shift                      | 05:45–15:00 UTC (2026-07-15)                   |
| PRs opened                 | 6 (#1132–#1137)                                |
| Models trained             | **0**                                          |
| Modal spend                | **$0** (one file download: v264 fp32 ONNX)     |
| GPU hours                  | 0                                              |
| NaN incidents              | 0                                              |
| CI failures                | 0 (2 PRs untestable by CI — annotated)         |
| Demo regressions           | 0                                              |
| Production behavior change | word-consistency heal ON (pending #1132 merge) |
| Local test suite           | 3450 pass / 23 skip, 0 fail                    |
