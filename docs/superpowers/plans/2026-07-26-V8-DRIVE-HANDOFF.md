# v8 drive handoff — DeepSeek takes the cut (2026-07-26)

**For:** DeepSeek (driving lead) · **From:** Claude (coordinating) · **Repo:** mailwoman @ `main`
(`c4713a54` or later).

You now own the drive to **v8.0.0**. The FST / comma-free / #1143 arc is closed and merged (#1319);
this doc hands you the cut. **The authoritative plan is `MAILWOMAN_ROAD_TO_V8.md` (on main) — read it
first.** This is the driver's synthesis on top of it: current state, the two open gates, sequencing,
the operator-only decisions, and the non-negotiable discipline.

---

## Where things stand (baseline — all merged to main)

- **FST arc:** #1315 street-context gate, #1317 trailing-locality prior (opt-in), #1318 per-locale FST
  distribution (default-on). #1319 wrap (release-staging fix + roadmap + retirement tracking).
- **Track F (correctness): SATISFIED.** #1143 CLOSED (waived to training #1102, not a decode bug),
  #1058/#1041/#1056 closed. This is one of the three cut gates — already done.
- **Release machinery is outage-safe.** `scripts/copy-weights.ts` now materializes `fst-<locale>.bin`
  into the weights packages (VERIFIED end-to-end: packs a real 3.8M file, zero symlinks in the
  tarball, files-guard passes). Before this, the next release would have shipped broken packages.
- **Comma-free is settled as a decode dead end** — the real fix is training (#1102). Do NOT reopen a
  decode mechanism for it; the open-vocab wall is structural.

## The mission

Cut **v8.0.0**. Per roadmap §4 there are three gates: **Track F** (done), **Track A** (breaking batch),
**Track B** (sharding skeleton). Per §1: _"v8.0.0 cuts when the breaking batch is staged AND the
sharding skeleton (Track B) is real."_ So your critical path is **A + B**. Everything else either
rides v8.x minors or gates itself.

---

## Gate 1 — Track A: the breaking-change batch (mechanical; a focused session, not an arc)

One **documented PR train**, a migration note per item, **NO behavior change** (the publish guard +
tarball verification run unchanged — behavior must not move in this track). The audit IS the task —
**re-verify each item against current main**, don't trust this list blindly:

- **#875 acronym batch** — the _public_ sweep already SHIPPED (AGENTS.md reconciled: zero exported
  lowercase-acronym identifiers remain). Residual is ~11 **internal cosmetic** locals across 6 files —
  non-breaking, optional. Do it or skip it; it does not gate the major.
- **#1096 `variant-aliases`** — zero runtime importers. Wire it into the pipeline OR remove the
  published workspace. **[OPERATOR DECISION — deleting a published package.]**
- **#1094 libpostal house/near/category** — check golden-gate traffic; if the excised labels stayed
  silent, drop the compat surface for real. **[OPERATOR DECISION if it removes public surface.]**
- **Exports/options audit** — ~5 dead pattern `exports` subpaths (`./schema/*.json` ×4 + core
  `./filters/*`, guard-invisible because the guard skips `*` patterns); 2 deprecated public option
  fields (`PipelineOpts.forceJointReconcile`, `ResolveOpts.cityStateFallback`); explicit `files[]`
  arrays for `spatial`/`tiger`/`cartographer`. Re-verify on main — some may have moved.
- **#1108 silent legacy-rule fallback** — the fallback removal may itself be a breaking change; §6 of
  the roadmap says decide inside this audit. **[OPERATOR DECISION.]**

**Gate:** the batch is one PR train with per-item migration notes; behavior does not move.

## Gate 2 — Track B: weights-sharding skeleton (epic #1177) — THE CRITICAL PATH

This is the pole that sets the cut date. The overlay _mechanism_ is shipped and battle-tested (the
en-gb/en-nz overlays; the fr-fr→en-us base). What's **unbuilt** is the _formalization_:

- **base-latn + overlays:** dedupe the per-locale weight packages onto one base Latin model with
  per-country overlay bundles. Work = packaging, card schema, and release-train wiring (the lockstep
  freshness guards generalize).
- **Script-routed shard router** — the non-Latin future (Track C) hangs off this; the router decides
  by script, not by locale guess.
- **The calibration runbook, first-class** — the per-country recipe (pair-index build + self-check
  probes, δ-sweep, β decision, venue-confound + golden boards, comma-drop metamorphic, invariance,
  card + ledger rows) currently lives as tribal knowledge in `task-8-report.md`; v8 makes it a doc
  in `CONTRIBUTING_MODEL_WORK` so country N+1 is a recipe, not an arc.

**Gate:** one existing overlay country re-cut onto the sharded layout with **byte-identical parse
output on its golden boards**, and the release train publishes the sharded family green. Scope it as
a proper arc — the runbook exists, the packaging/release engineering doesn't.

## Explicitly NOT gating v8.0.0 (do not block the cut on these)

Track C (non-Latin JP/KR/CJK — #1176/#1266, rides minors), most of Track D (evidence-layer second
index family — #1288/#1296/#1267, each gates itself), Track E base models (gate on #1102 whenever
they arrive). Surface them, don't let them hold the cut.

## The cut itself (once A + B land)

- **Two-phase PR publish flow ONLY** (`mailwoman-release` skill + `RELEASING.md`) — never local.
- **Version = v8.0.0** (major; the breaking batch is the justification). Verify the number first:
  `npm view mailwoman version` + `git tag -l 'v*'`, take the next after the latest published.
- **HF staging now includes per-locale `fst-<locale>.bin`** — your own publish-hf change enables it;
  pass `--fst` per locale for en-us/fr-fr/en-gb (en-nz has none). The npm packages already carry the
  FST via copy-weights, so this staging is for the demo/CDN path.
- **Post-cut:** the demo repoint (strictly post-cut — the operator has deferred it repeatedly; do NOT
  repoint the production demo autonomously) and Track C minors.

## Standing obligations carried into v8 (don't drop these)

- **#1320** — re-run the #1318 FST default-on battery at the next model promotion; if the −6.8pp FR
  admin-street-homonym flips positive (v3101 predicts +13), the bar revision retires; if not, we've
  shipped a durable regression and must gate the prior harder or revert default-on.

## Discipline (non-negotiable — carry all of it into v8)

1. **Verify before verdict.** Re-run any load-bearing number on the live CLI before acting; a report
   (including this one) is not truth.
2. **Measure in the SHIPPED configuration.** Candidate-cache numbers ≠ shipped numbers; when an
   identical-artifact rerun disagrees, suspect the cache.
3. **Pre-register bars in writing before measuring** (`.superpowers/sdd/progress.md`, dated). A bar
   revision is dated + operator-ratified + carries a retirement condition — never silent.
4. **Preserve the operator's WIP across every pull.** `corpus-python/modal/train_remote.py`
   (`sync_latam_br` / `sync_gb`) and `corpus-python/src/mailwoman_train/configs/v3.10.0-gb-probe.yaml`
   are UNCOMMITTED and the OPERATOR'S. `git stash push` those exact paths → pull → `git stash pop` →
   verify `grep -c "def sync_latam_br" corpus-python/modal/train_remote.py` == 1. Never commit them;
   never pathless `git checkout -- .`.
5. **PR everything from `origin/main`; releases via the two-phase flow only.** No silent gate drift —
   a shipped regression needs a dated, ratified bar revision with a retirement condition.

## Operator-only decisions (do NOT decide these alone — surface and wait)

- Track A: delete-vs-wire #1096; remove #1094 public surface; the #1108 fallback removal.
- The **v8.0.0 cut go/no-go**.
- The **demo repoint** (post-cut).

Everything else — the mechanical batch, the #1177 engineering, the audits, the measurements — drive
autonomously under the discipline above. Checkpoint the operator at each gate boundary (Track A
staged; Track B green; ready to cut).

## Pointers

- `MAILWOMAN_ROAD_TO_V8.md` — the source of truth. §4 = cut criteria, §6 = open-decisions register.
- `docs/superpowers/plans/2026-07-26-WRAP-HANDOFF.md` + `2026-07-25-SESSION-REPORT-fst-arcs.md` — the
  just-closed arc.
- `.superpowers/sdd/progress.md` — the dated ledger.
- `docs/articles/plan/CONTRIBUTING_MODEL_WORK.mdx` — where the Track B calibration runbook lands.
- #1320 — the standing retirement obligation.
