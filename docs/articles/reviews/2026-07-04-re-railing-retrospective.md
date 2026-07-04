# Re-railing retrospective — 2026-07-04

**Date:** 2026-07-04 · **Scope:** what actually happened against the
[2026-07-01 trajectory review](./2026-07-01-claude-trajectory-review.md)'s risks, tracks, and
success criteria — written three days after that review set a **four-week** bar. Companion to it,
same method: git history + the dated eval/gate records, direction not code quality.

---

## Verdict

The review's four-week success state was reached in three days, and then exceeded in a direction
the review didn't anticipate: the measurement system it asked us to repair started **finding
shipped defects on its own** — including one (#949) that the model line's newest release existed
to create, and which the next release (v5.3.0, cut today) exists to fix. The re-railing worked
not because the plan was executed line by line, but because the two disciplines it protected —
pre-registered gates and coordinate-first grading — compounded once the record-keeping around
them was repaired.

The numbers that frame the three days: **80 commits to main, 29 issues closed, four releases
(5.0.0 → 5.3.0), zero regressions shipped knowingly, and roughly $0 of new GPU spend against
~7.5 A100-hours' worth of shipped model improvements** — because both model wins were salvaged
from artifacts the old process would have re-trained (the vocab-splice needed no training at all;
v2.2.0 was promoted from the archive after a re-gate replaced a ~4 A100-h rerun).

The headline the whole arc rolls up to: on 2026-07-01 a Czech address had a **44% chance** of
resolving to the wrong city. Today it is **6.6%**, Polish is 6.2%, Slovak 6.6%, and the fix
class that drove it (diacritic tokenization) went from "stalled with no probe" to two shipped
tokenizer generations, one from-scratch retrain, a proven-impossible residual class, and a
model-independent resolver floor covering that residual.

---

## The six risks, re-scored

**R1 — metric substitution without a re-anchor: CLOSED, and the backstop has already fired.**
The #885 re-score ran (17/17 floors, first full scorecard since 06-11), the ledger was revived
with an **automated** append (`ledger-append.ts`, invoked from the promotion gate's PASS output —
the fix targeted why it froze, not just that it froze), and the cadence rule is in
CONTRIBUTING_MODEL_WORK as a gate. Evidence it works: the re-score surfaced two unsigned drifts
(fr.cedex_real −6.7, libpostal clean arena −6); the zero-margin postcode floor it documented
fired on the very next candidate (v2.2.0's fr.postcode −0.1) and was **adjudicated at a fork
instead of absorbed**; and the salvage read that found #949 was this discipline pointed at a
harness nobody had re-run.

**R2 — the hardest model problem stalled with no probe: TRANSFORMED into a solved-and-mapped
territory.** The diacritic arc ran end-to-end: the $0 vocab-splice shipped (5.1.0, four locales),
a second splice generation followed (5.2.0, nordic), the from-scratch retrain question was run
to ground (v2.2.0), and the one class no training composition can hold (SI/FR no-street
short-forms — five vehicles, all falsified, including from-scratch) got a **model-independent
resolver floor** (#942, default-ON, all 55 composition-lost rows recovered). That last move is
the deepest new pattern of the period: when the model provably cannot learn a class, stop buying
GPU and floor it in the resolver. CharCNN remains parked as the CJK-forward path, now with a
public introspection tool that would make its evaluation visible.

**R3 — the demo lies about the product: CLOSED.** The browser runs the shared `resolveTree`
(#861 — Toledo-Spain and Barcelona-Venezuela became permanent smoke rows that only pass on the
shared path), the demo default tracks the npm line, and introspection went from zero to a public
`/trace` page (#941) that renders the decode path band by band — the tool that would have made
#949 visible the day it shipped. Residual: the #894 structural version-lag check is filed but
not yet wired.

**R4 — operator-gated decision backlog: DRAINED by folding decisions into evidence.** The
review's Track 3 imagined a decision sitting; what actually worked was presenting each decision
as a pre-framed fork at the moment its evidence completed (the SLO overage, the ledger's fate,
the re-score cadence, the v220 promote). Every fork resolved within hours of being posed. The
open queue is now genuinely externally-blocked-or-owned items, not re-triage fodder.

**R5 — the record of record is stale: CLOSED, and now self-correcting.** releases.mdx is current
through 5.3.0; SCOPE.mdx exists (locale tiers, two workstreams, five invariants); the
runtime-flag register exists with per-flag verdicts and named drifts. The proof it's a live
discipline rather than a one-time cleanup: the 5.2.0 cut (made under time pressure in a parallel
session) skipped its releases.mdx row and left release.config.json stale — and the 5.3.0 prep
**caught and repaired both** as a matter of course.

**R6 — breaking sweeps mid-campaign: HELD.** No breaking cosmetic batch landed mid-campaign;
#875 stays parked for the next major. The tax of the earlier sweep kept surfacing as key-rot
(`postcodeDbByCountry` silently skipping postcode binaries at 5.1.0 prep) — each instance
repaired on contact, reinforcing the ship-whole-or-wait rule.

---

## The five tracks, settled

| Track                     | Plan           | Actual                                                                                                                                                                                                                                                                        |
| ------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — demo truth            | days           | #861 shipped (shared resolver, zero smoke flips, two #822 acceptance rows); demo repointed; /trace added beyond scope. #894 (structural lag check) open.                                                                                                                      |
| 2 — measurement re-anchor | days           | #885 scorecard + revived automated ledger + cadence rule + truth-passes; two unsigned drifts recorded.                                                                                                                                                                        |
| 3 — decision session      | hours          | Dissolved into per-fork adjudication; every fork closed same-day.                                                                                                                                                                                                             |
| 4 — #825, probe-first     | the funded one | Rewritten by the addendum, then exceeded: 5.1.0 (splice, $0), 5.2.0 (nordic), 5.3.0 (from-scratch v2.2.0, salvaged from the archive) — the "funded campaign" ultimately spent ~3.6 A100-h once, and its artifact shipped after the calculus changed rather than being re-run. |
| 5 — scope re-declaration  | half a day     | SCOPE.mdx + the flag register (which found two default split-brains, #895) + plan/README marked historical.                                                                                                                                                                   |

The review's "what not to do" held on all four counts: no resolver micro-levers past the frontier
(the residual went to a _typed floor_, not a lever), no breaking sweeps, no new locales before
the coordinated bump (the freeze lifted exactly when designed), no new workstreams before 1–3.

---

## What the review didn't anticipate

1. **Model-independent flooring as an architecture pattern (#942).** The review's frame was
   "train it or defer it." The period's most important finding is a third option with a
   worked example: prove the class composition-insensitive (five falsified vehicles is what
   proof looks like), then floor it downstream where the knowledge already exists. The insurance
   leg — running the _failed candidate_ over the floor to show the class recovers — is the
   template for de-risking every future promote against that class.

2. **Salvage-first now has GPU-scale receipts.** Twice in three days the cheapest decisive step
   replaced a training run: the tokenizer probe replaced the #825 retrain class entirely, and
   the v220 re-gate replaced a same-shape rerun. Both were pre-registered _before_ measurement,
   with explicit falsified-by-copy branches. "No GPU while an archived artifact dominates the
   target class" is now a demonstrated rule, not a slogan.

3. **The gates catch real things at both ends of the lifecycle.** Pre-ship: the v2.2.0 wall
   held under the old calculus and the SI bar failed as-registered under the new one (then went
   to a fork, by the book). Post-ship: the standing 40-row FR harness — re-run only because a
   retrain directive triggered salvage-first — caught #949 on the _shipped_ line. The gap it
   exposed (no fr.street-class floor; golden-dev FR is postcode-anchored canonical) is the next
   gate-spec improvement, and it rhymes with the review's R1 exactly: the blind spot was a slice
   nobody re-measured.

4. **Introspection as a product surface.** #941's parse-trace + visualizer turns the decode path
   into something a visitor can watch. Its review hardened the trace's _contract_ (per-piece
   repair alignment through token merges, effect-semantics for priors, a self-describing
   locale axis) — the kind of precision that matters precisely because the tool's job is to be
   believed.

5. **The record discipline catching its own lapses.** The strongest signal that the re-railing
   stuck isn't any single artifact — it's that when a parallel session's release cut skipped two
   bookkeeping steps, the _next_ release's checklist surfaced both without anyone hunting.

---

## The model line, 2026-07-01 → 2026-07-04

|                         | 07-01 (v4.16.2/v5.0.0 line)           | 07-04 (v5.3.0)                                          |
| ----------------------- | ------------------------------------- | ------------------------------------------------------- |
| CZ wrong-city           | 44% (150-row read; 22.4% at n=1k)     | **6.6%**                                                |
| PL wrong-city           | 30% / 7.1%                            | **6.2%**                                                |
| SK / SI wrong-city      | unmeasured                            | **6.6% / 11.4%** (SI floored by #942)                   |
| FR bare street-intact   | 90%-era claim; demo-only fix off-line | **34/40 (85%)**, on the main line, anchored 37/40       |
| SE resolve              | 90.2%                                 | **94.8%**                                               |
| Åbo (the exonym case)   | 859 km                                | **0.12 km**                                             |
| US coord p50            | 3.31 km                               | **3.27 km** (identical through three model generations) |
| Vocab                   | 48,000 (diacritic-blind)              | 58,582+ nsplice (two splice generations)                |
| Tier-3 locales measured | ~8                                    | all obtainable (IE/GB/HU lack sources)                  |

The US row is the quiet one worth naming: three successive model generations — a spliced
embedding, a second splice, and a from-scratch retrain — shipped with the US coordinate
_identical to the row level_. That is what the guarantee-by-construction discipline plus
byte-level verification buys.

---

## What's genuinely open

- **#949's structural fix**: an fr.street-class floor (or the bare-street-intact rate itself) in
  the gate spec — the incident's lesson, distinct from its instance.
- **#894** (demo version-lag CI check) and **#895** (the D1/D2 default flips) — both unblocked,
  both small.
- **#897** residual wrong-city mechanics (span truncation → namesake binding) — the next
  model-side question, now cleanly separated from everything the splices fixed.
- **Calibration re-fit** — the carried isotonic tables now sit under from-scratch weights; the
  standing recommendation has real force for the first time.
- **#727 span-head / CharCNN** — the two architecture directions, both still correctly parked
  behind evidence they'd need.

## The honest caveats

Three days is a sprint, not a trend; the four-releases-in-four-days cadence is sustainable only
because three of the four shipped pre-existing artifacts. The SI trade shipped today is real
(−1.5pp resolve, +2.7pp wrong-city at the model level) and its floor is a resolver behavior —
if #942 ever regresses, SI regresses with it, which is why the insurance leg belongs in the
standing battery. And the parallel-session bookkeeping lapses (5.2.0's row, the config) show the
process still depends on the _next_ careful actor; #894-class structural checks are how that
dependency retires.

---

_The 2026-07-01 review closed by defining "back on rails" as pointed where it is going, not
faster. Three days later the honest summary is: both — and the speed came from the rails._

---

## Addendum — 2026-07-04, fourteen hours later

This review was written at 04:10. By evening, the same day's work had both strengthened its
thesis and falsified one of its verdicts. A review whose theme is record accuracy corrects its
own record; this is that correction.

### R3 was scored wrong: the demo had been lying since July 1

The section above closes R3 on the strength of #861's shared `resolveTree` and its smoke rows.
The evening's investigation of an operator bug report proved the opposite: **the production demo
had been silently degraded since July 1** — three stacked failures, each masking the next.

1. The street tier was dead (#955): the acronym sweep renamed the _external_
   `window.createDbWorker`, sql.js-httpvfs's own export.
2. The WOF cascade and the FST were dead (#957/#958): the sweep capitalized the `releases.json`
   reads (`hasFST`/`hasWOFDb`) while the published manifest kept the old keys — every release
   read `undefined`, and both features switched off with zero console errors.
3. Deepest: **#861's shared cascade had never executed in production at all** (#959). Its
   `createWOFResolver` import hit a deliberate webpack barrel-bypass alias whose comment still
   said "createWOFResolver is never bundled" — a premise that went stale the day #861 merged.
   The smoke rows this review cites pass in CI builds; production diverged invisibly.

The repair kept the house naming and migrated the wire (operator direction): one tolerant
boundary (`normalizeReleasesManifest`), the publisher on house keys, the R2 manifest migrated
after the tolerant reader deployed, and contract tests pinning all of it. Verified live via
Playwright: an address-point rooftop hit and an SI village through the browser cascade, markers
on both — all three tiers working together in production **for the first time since July 1**.

The corrected R3 verdict: _the code convergence was real; the deployment truth was not._ And the
caveat this review already carried — "the process still depends on the next careful actor" — now
has four exhibits instead of one. #894-class structural checks are no longer the retirement path
for a dependency; they are overdue.

### The v5.2.0 grading claim this document inherits is also wrong

The model-line table and the release notes carry v5.2.0's "14/14 per-locale non-inferiority
PASS." The #945 investigation found that **9 of the 16 release-grading baselines were byte-copies
of the v1 candidate's dumps** — never re-run against the artifact that shipped. Eight copies were
benign; the ninth was FR, the one leg where v2 truly differed, and it was a regression
(resolved-p50 2.64 → 4.12) whose root cause predates every model: the FTS sanitizer has fused
intra-token punctuation since #95, unmatchable for every hyphenated name, masked for years by
tokenizers that never emitted hyphen-preserved values. The fix (#948) shipped inside v5.3.0;
the corrected verdict is 7 legs graded + 9 copied, FR failing unobserved. Two standing rules
came out of the erratum: **never copy dumps across model labels**, and **tokenizer directories
are immutable** (the v1 tokenizer was overwritten in place, making a direct re-grade impossible
forever).

### What the same evening added to the R1 column

The measurement system kept finding things: the eval harness's coordinate convention was proven
to differ from production's (postcode point vs locality), and the repair became a declared
**convention epoch** (2026-07-04) — the harness now scores what production serves, FR reads
1.92 km under it, `postcodeConsistency` (#370) went default-ON behind a corrected gate
(FI 231 wins / 0 losses; US byte-flat), and every pre-epoch dump is retired from comparisons.
One false verdict was published and retracted within the hour along the way (a shell
word-splitting bug ran gate legs flagless) — caught because the code contradicted the
measurement, which is the discipline working exactly as this review describes it.

### The open list, re-scored at day's end

- **#894** — unchanged in content, tripled in urgency; the demo outage is its fourth exhibit.
- **The #942 insurance leg in the standing battery** — this review recommended it; still to land.
- **#949's fr.street gate floor** — the convention epoch gave FR standing baselines; the gate-spec
  floor remains unwritten.
- #897, the calibration re-fit, #727/CharCNN — unchanged.
