# v8 drive handoff — DeepSeek takes the result (2026-07-26)

**For:** DeepSeek (driving lead) · **From:** Claude (coordinating) · **Repo:** mailwoman @ `main`
(`c4713a54` or later).

You now own the work toward **v8.0.0**. The FST / comma-free / #1143 arc is closed and merged
(#1319), and this doc hands its result to you. **The authoritative plan is `MAILWOMAN_ROAD_TO_V8.md`
(on main). Read it first.** This doc summarizes the plan for the driver: current state, the two open
checks, sequencing, the operator-only decisions, and the working rules that must be followed.

---

## Where things stand (baseline — all merged to main)

- **FST arc:** #1315 added the street-context check, #1317 the trailing-locality prior (opt-in), and
  #1318 per-locale FST distribution (default-on). #1319 closed the arc with a release-staging fix,
  the roadmap and retirement tracking.
- **Track F (correctness) is complete.** #1143 is closed and was waived to training work (#1102)
  because it is a training problem rather than a decode bug. #1058, #1041 and #1056 are closed.
  Track F is one of the three release checks.
- **The release path no longer ships broken packages.** `scripts/copy-weights.ts` now materializes
  `fst-<locale>.bin` into the weights packages. An end-to-end run packed a real 3.8M file with zero
  symlinks in the tarball, and the files guard passed. Before this change, the next release would
  have shipped broken packages.
- **Comma-free parsing cannot be fixed in decode.** The fix belongs in training (#1102). Do not
  reopen a decode mechanism for it, because the open-vocabulary limit is structural.

## The mission

Release **v8.0.0**. Roadmap §4 lists three checks: **Track F** (done), **Track A** (breaking batch)
and **Track B** (extract routing skeleton). Roadmap §1 says: _"v8.0.0 reduces when the breaking
batch is staged and the extract routing skeleton (Track B) is real."_ Your critical path is
therefore **A + B**. Everything else either goes into v8.x minors or has its own check.

---

## Check 1 — Track A: the breaking-change batch (mechanical; a focused session rather than an arc)

Ship the batch as one **documented PR train** with a migration note per item and **no behavior
change**. The publish guard and tarball verification run unchanged. The audit is the main work:
**re-verify each item against current main** instead of trusting this list.

- **#875 acronym batch:** the _public_ sweep already shipped, and AGENTS.md is reconciled with zero
  exported lowercase-acronym identifiers remaining. About 11 **internal cosmetic** locals across 6
  files remain. They are non-breaking and optional, and the major release does not depend on them.
- **#1096 `variant-aliases`:** the package has zero runtime importers. Wire it into the pipeline or
  remove the published workspace. **[OPERATOR DECISION, because it deletes a published package.]**
- **#1094 libpostal house/near/category:** check golden-check traffic. If the excised labels stayed
  silent, remove the compat surface. **[OPERATOR DECISION if it removes public surface.]**
- **Exports/options audit:** about 5 dead pattern `exports` subpaths (`./schema/*.json` ×4 plus core
  `./filters/*`). The guard skips `*` patterns, so it cannot see them. There are 2 deprecated public
  option fields (`PipelineOpts.forceJointReconcile`, `ResolveOpts.cityStateFallback`), and
  `spatial`/`tiger`/`cartographer` need explicit `files[]` arrays. Re-verify on main, since some of
  these may have moved.
- **#1108 silent legacy-rule fallback:** removing the fallback may itself be a breaking change.
  Roadmap §6 says to decide this inside the audit. **[OPERATOR DECISION.]**

**Check:** the batch is one PR train with per-item migration notes, and behavior does not change.

## Check 2 — Track B: weights-extract routing skeleton (epic #1177) — THE CRITICAL PATH

Track B determines the release date. The overlay _mechanism_ has shipped and is in production use
(the en-gb/en-nz overlays and the fr-fr→en-us base). The _formalization_ is **unbuilt**:

- **base-latn + overlays:** dedupe the per-locale weight packages onto one base Latin model with
  per-country overlay bundles. The work is packaging, card schema and release-train wiring. The
  lockstep freshness guards generalize to the new layout.
- **Script-routed extract router:** the non-Latin work (Track C) depends on this router, which
  chooses by script rather than by a locale guess.
- **The calibration runbook as a document:** the per-country recipe covers the pair-index build and
  self-check probes, the δ sweep, the β decision, venue-confound and golden boards, the comma-drop
  metamorphic test, invariance, and card and ledger rows. It exists only in `task-8-report.md`
  today. v8 moves it into `CONTRIBUTING_MODEL_WORK`, so that adding another country follows a
  recipe instead of requiring a new arc.

**Check:** one existing overlay country is rebuilt onto the attached layout with **byte-identical
parse output on its golden boards**, and the release train publishes the attached family green.
Scope this as a full arc. The runbook exists, but the packaging and release engineering do not.

## Explicitly not blocking v8.0.0 (do not block the result on these)

These items do not block v8.0.0: Track C (non-Latin JP/KR/CJK, #1176/#1266, which goes into
minors), most of Track D (the evidence-layer second index family, #1288/#1296/#1267, each with its
own check), and Track E base models (checked on #1102 whenever they arrive). Report on them, but do
not let them delay the release.

## The result itself (once A + B land)

- **Use only the two-phase PR publish flow** (`mailwoman-release` skill and `RELEASING.md`). Never
  publish locally.
- **The version is v8.0.0**, a major release justified by the breaking batch. Verify the number
  first with `npm view mailwoman version` and `git tag -l 'v*'`, and take the next version after the
  latest published one.
- **HF staging now includes per-locale `fst-<locale>.bin`**, enabled by your publish-hf change. Pass
  `--fst` per locale for en-us, fr-fr and en-gb (en-nz has none). The npm packages already carry
  the FST through copy-weights, so this staging serves the demo/CDN path.
- **After the release:** the demo repoint and the Track C minors. The repoint happens strictly after
  the release. The operator has deferred it repeatedly, so do not repoint the production demo
  without the operator.

## Standing obligations carried into v8 (don't drop these)

- **#1320:** re-run the #1318 FST default-on battery at the next model promotion. If the −6.8pp FR
  admin-street-homonym result turns positive (v3101 predicts +13), the bar revision is retired. If
  it does not, the project has shipped a durable regression and must test the prior harder or
  revert default-on.

## Discipline (non-negotiable — carry all of it into v8)

1. **Verify before reaching a verdict.** Re-run any number you rely on with the live CLI before
   acting. A report, including this one, can be wrong.
2. **Measure in the shipped configuration.** Candidate-cache numbers can differ from shipped
   numbers. When a rerun on an identical artifact disagrees, suspect the cache.
3. **Pre-register bars in writing before measuring** (`.superpowers/sdd/progress.md`, dated). A bar
   revision must be dated, ratified by the operator, and carry a retirement condition.
4. **Preserve the operator's uncommitted work across every pull.**
   `corpus-python/modal/train_remote.py` (`sync_latam_br` / `sync_gb`) and
   `corpus-python/src/mailwoman_train/configs/v3.10.0-gb-probe.yaml` are uncommitted and belong to
   the operator. Run `git stash push` on those exact paths, pull, run `git stash pop`, and verify
   that `grep -c "def sync_latam_br" corpus-python/modal/train_remote.py` returns 1. Never commit
   them, and never run a pathless `git checkout -- .`.
5. **Open every PR from `origin/main`, and release only through the two-phase flow.** A shipped
   regression needs a dated, ratified bar revision with a retirement condition. Checks must not
   drift silently.

## Operator-only decisions (do not decide these alone — surface and wait)

- Track A: delete or wire #1096, removal of the #1094 public surface, and the #1108 fallback
  removal.
- The **v8.0.0 release go/no-go**.
- The **demo repoint** (after the release).

Drive everything else on your own under the rules above: the mechanical batch, the #1177
engineering, the audits and the measurements. Check in with the operator at each check boundary:
Track A staged, Track B green, and ready to release.

## Pointers

- `MAILWOMAN_ROAD_TO_V8.md` is the authoritative record. §4 holds the release criteria, and §6 is
  the open-decisions register.
- `docs/superpowers/plans/2026-07-26-WRAP-HANDOFF.md` + `2026-07-25-SESSION-REPORT-fst-arcs.md`
  describe the arc that closed on 2026-07-26.
- `.superpowers/sdd/progress.md` — the dated ledger.
- `docs/articles/plan/CONTRIBUTING_MODEL_WORK.mdx` — where the Track B calibration runbook lands.
- #1320 — the standing retirement obligation.
