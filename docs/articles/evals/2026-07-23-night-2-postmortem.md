# Night shift #2 postmortem — 2026-07-23

Drafted during the shift; finalized at hand-off. Window: ~04:50–15:00 UTC (conn handed with full
ship autonomy: training, publishing, merging, HF — all behind the pre-registered gates).

## What shipped

- **HF backfill**: `pair-index-gb.bin` staged to `en-us/v6.6.0/` and md5-verified round-trip
  (`1e63a8c1…`). The publish preflight is now fully green (all six binaries HEAD-check OK) — the
  standing action item from the placetype-pair arc is closed.
- **PR #1253** (open, CI green, mergeable): the v3.12.0-comma-robust config as a run record + the
  deploc redesign dossier (`docs/superpowers/plans/2026-07-23-deploc-redesign-dossier.md`). The
  night-merge classifier blocked self-merge, as designed — one click in the morning.
- **No model shipped. No npm release shipped.** Both outcomes were gate-driven, not omissions
  (details below).

## The v3.12.0 verdict — stop rule executed (second time)

The run itself was flawless mechanically (all startup gates green: 702 shards, init_from
missing=0, reinit rows [7,8], classifier LR group 12,705 params @ 0.001). Graded per the
pre-registration — all 8 checkpoints, invariance suite in `--baseline v385` mode + gauntlet per
checkpoint:

| Checkpoint | Invariance NEW violations | Gauntlet                                  |
| ---------- | ------------------------- | ----------------------------------------- |
| 1k–4k      | 6–9                       | 3                                         |
| 5k–7k      | 5–7                       | **1** (Pennsylvania only; NY-trio healed) |
| 8k         | 8                         | 3 (+ NEW 1295 km mislocation — regresses) |

- **PRIMARY FAIL**: zero gauntlet-clean checkpoints. The `INV[comma-drop]` Pennsylvania-Ave break
  is a NEW violation vs v385 at every checkpoint.
- **Comma-share hypothesis FALSIFIED**: matching the base corpus's 37.7% comma-free share
  (`augment_punct_drop_prob` 0.3→0.6, the one pre-registered variable) did not move the break.
  Fourth falsified mechanism in the arc.
- **NZ-flow read MET, decisively**: first NZ `dependent_locality` decode emissions in the arc's
  history (peak 5/246 decode, 100% tag-correct where fired) after the `country_weights` NZ
  allowlist restoration. The whole v3.11.x lineage had drawn zero synth-nz rows.
- Full battery deliberately withheld — no checkpoint passed PRIMARY, so guard numbers on a
  non-candidate would only invite bar-shopping.

Per the stop rule: no knob iteration, no resume extensions; the model side goes to redesign.
**The morning read is the dossier** — falsification table (4 closed hypotheses with receipts),
what's solidly true, the surviving hypothesis space with zero-GPU-first probes, and options A–D
with costs (A+B combined ≤ ~$5; D — en-GB on v385 — is already the shipped state and composes
with A/B).

## The v7.6.0 code-only release — blocked by the new ruleset, rolled back clean

Rationale for attempting it: merged main carries five production bug fixes (tokenizer
byte-fallback offset corruption, two word-grouping drop classes, two formatter slot-rendering
classes) plus the en-gb overlay first-publish and the inert-until-model pair prior. Model
unchanged (v385 / card 6.6.0) — demo-safe by the ship-discipline bar.

Sequence: version determined (7.5.0 published → target 7.6.0), preflight-mirror green, **dry-run
green**, real dispatch (run 29982294750) **failed at release-it's git push**: ruleset
**"Production Integrity"** (id 19486155, created 2026-07-22 00:10 +02:00 — after v7.5.0) requires
PR + `test` check on main; bypass list is OrganizationAdmin only, so Actions is deliberately
excluded. **Not bypassed** — a fresh operator-made security control is not something the night
shift loosens. Rollback verified clean: no v7.6.0 tag on the remote, main unchanged at
`e941c698`, npm still 7.5.0, en-gb never published, and release-it's `--tolerate-republish` makes
any re-dispatch safe.

## What went well

- Gate discipline held under a full-autonomy grant, twice: no ship on a NOT-CLEAN model, no
  bypass of the branch ruleset. Both were live temptations; both had pre-registered answers.
- The invariance suite did exactly its designed job on its first mandatory outing — cheap
  per-checkpoint verdicts, and the severity-aware baseline mode made "NEW violation class" a
  mechanical read instead of a judgment call.
- The long-lived grading agent (all harnesses + model caches warm) turned an 8-checkpoint ladder
  plus the battery decision around in ~16 minutes.
- The falsification chain is now a genuine asset: four mechanisms closed with receipts is what
  makes the morning redesign discussion short.

## What could've gone better

- I discovered the ruleset by hitting it. A pre-flight `gh api …/rulesets` check before any
  release dispatch would have converted a failed real run into a morning question. → Added to the
  release-skill gotcha candidates below.
- My version knowledge was stale (assumed 7.2.x era; npm was at 7.5.0). Step 0 caught it — but
  it's a reminder that ledger memory ≠ registry state; `npm view` is the only source.

## Decisions made autonomously

| Decision                                       | Alternatives                                   | Why                                                                                    |
| ---------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| Withhold full battery on v3.12 non-candidates  | run it "for information"                       | PRIMARY already failed; numbers on a dead checkpoint invite re-litigation              |
| Attempt the code-only v7.6.0 release           | wait for morning                               | explicit grant ("publishing"); five production fixes; model untouched                  |
| Stand down on GH013 rather than bypass/rework  | add Actions bypass; hand-roll PR-based release | ruleset is under 36h old and operator-made; loosening it is not the night shift's call |
| PR #1253 as a run-record PR (config + dossier) | leave the branch local                         | the falsified run's config header is the arc's provenance; belongs on main             |

## Open questions (operator)

1. **Release path**: Actions bypass on "Production Integrity", or rework publish.yml to a
   PR-based release flow? Until one happens, no npm release can ship. (v7.6.0 is otherwise
   ready: preflight green, dry-run green.)
2. **Redesign fork**: dossier options A (diagnose-first, zero-GPU probes headlined by gauntlet-
   grading the already-local cRT checkpoints) / B (two-phase LR schedule, never tried, launch-
   ready) / D (locality-mapped v1 = current shipped state, zero risk for October). C
   (accept-and-gate 7k's single violation) is on the table only as an explicit gate revision.
3. Merge the night's PRs (all CI-green): #1253 (run record + dossier + v3.13 option-B recipe
   proposal), #1254 (this postmortem), #1255 (release-skill gotcha), #1256 (CJK byte-fallback
   fix), #1257 (pair-index country-gate warn-branch test), #1258 (fileMD5 dedup).

## Concrete next steps

- Morning: merge #1253–#1258; pick the release-path fix; pick the redesign run — the cRT
  diagnostic makes B the favored candidate, and its recipe is pre-drafted as an operator-gated
  proposal (`docs/superpowers/plans/2026-07-23-v313-two-phase-recipe.md`, on #1253; the one open
  parameter is the phase boundary, 2000 vs 3000).
- If the release path reopens: re-dispatch `publish.yml -f version=7.6.0` — everything upstream
  is verified green; then the demo repoint question (separate task, unchanged tonight).
- Deferred backlog: EMPTY — all three items closed during the shift (see the idle-backlog
  addendum).

## Idle-backlog addendum (worked after the wrap sections above were drafted)

- **cRT comma-drop diagnostic (the dossier's headline zero-GPU probe) — run tonight, free.**
  With the encoder frozen the entire cRT run, the Pennsylvania break is absent at 2k/4k/6k and
  present at 8k — the identical failure signature as the full fine-tune. The break originates in
  classifier-head dynamics; hypothesis (c) substantially weakened; **option B (two-phase LR
  anneal) is now the mechanistically favored run.** Dossier postscript on #1253.
- **CJK byte-fallback residual FIXED — PR #1256.** Per-character run splitting at UTF-8 sequence
  boundaries; +4 exact-tuple characterization tests (東京都渋谷区, mixed-script, curly-quote
  no-op, emoji surrogate span); neural suite 380 → 384 green, Latin byte-identical. Reviewed
  in-session. Closes the v8 non-Latin hard blocker pending merge.
- **Pair-index country-gate warn-branch test — PR #1257** (mispackaged-sibling fixture via a
  temp cacheRoot layout; the gate's warn branch had zero coverage). **fileMD5 dedup — PR #1258**
  (local helper → the blessed `md5File` in core/utils). **v3.13 option-B recipe pre-drafted**
  (operator-gated proposal on #1253 — the morning green-light is one word).
- **Release-skill ruleset gotcha — PR #1255** (preflight `gh api …/rulesets` before any real
  dispatch; do-not-loosen rule; verified rollback behavior).

## Numbers

| Metric               | Value                                                      |
| -------------------- | ---------------------------------------------------------- |
| Shift window         | ~04:50–15:00 UTC                                           |
| Models trained       | 1 (v3.12.0-comma-robust, 8k steps, A100 ~25 min)           |
| Modal spend          | ~$1.50                                                     |
| Checkpoints graded   | 8 (invariance + gauntlet each; battery withheld by design) |
| NaN incidents        | 0                                                          |
| Ships to npm/HF/demo | 0 / 1 backfill (pair-index → v6.6.0) / 0                   |
| Regressions shipped  | 0                                                          |
| GPU lost to error    | 0                                                          |
