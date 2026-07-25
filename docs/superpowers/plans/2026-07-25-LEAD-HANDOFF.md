# Lead handoff — comma-free locality fix, v8 cut state, and working discipline

**Date:** 2026-07-25 · **From:** the outgoing lead (Claude, this session) · **For:** the next lead
(DeepSeek / Kimi / whoever takes the conn) · **Repo:** mailwoman @ `main`, package 7.8.1 / bundle
6.6.3 / model bytes v385.

This is a self-contained handoff. Read it top to bottom before touching anything. The deep detail
lives in `.superpowers/sdd/task-8-report.md` (every probe/battery this session, in order),
`.superpowers/sdd/progress.md` (the running ledger — the authoritative state record), the v8
roadmap `MAILWOMAN_ROAD_TO_V8.md`, and the country-onboarding runbook
`docs/articles/plan/reference/country-evidence-layer-runbook.mdx`.

---

## 0. Non-negotiable working discipline (read first — this is why the work held)

These are not style preferences; every one was earned with a receipt this session. Violate them
and you will ship a regression or waste a day.

1. **Diagnostic-first.** Never build on a hypothesis. Run the cheapest experiment that could
   falsify it (a zero-GPU probe, a lattice matrix analysis, a raw-BIO read) BEFORE writing code.
   Multiple "obvious" fixes (venue-pair prior #1287, street-pair prior #1288) were killed this way
   for the cost of a probe instead of an arc.
2. **Pre-register the bars in writing BEFORE measuring.** Put the acceptance bars in the ledger
   (`.superpowers/sdd/progress.md`) with a dated header, then run the battery. No knob iteration
   inside a pre-registration. No dropped failing rows. If a bar turns out stale mid-battery, revise
   it explicitly with a dated note + operator ratification — never silently.
3. **Verify before verdict — especially claims that contradict known-good state.** A subagent's
   self-report is not truth. Twice this session a probe's headline was wrong (an NZ "resurrection
   gap" that was really a preset artifact; a "0.215 baseline" that was really ~0.6). Both were
   caught by re-running the claim on the live CLI myself. See §5 (integrity) — this is now mandatory
   for load-bearing numbers.
4. **Measure in the SHIPPED configuration.** Harness caches lie. GB comma-free recall read 50/69
   through an en-us-shaped cache with no `postcode-gb.bin` (anchor channel silently off); the real
   number was 55/69. en-nz venue FP read 0.862% off a borrowed cache; the shipped-config number was
   1.354%. Pin the harness to production defaults (`postcode-<cc>.bin` present, anchor+gazetteer on)
   before trusting any number. When an identical-artifact rerun disagrees, suspect the cache.
5. **Candidate geometry before calibration.** The false-positive surface is a geometry property,
   not a δ magnitude — window-mode pair matching hit 79% venue FP at δ=10, and dropping δ only moved
   it to 53%; recall and FP fall together. You cannot calibrate out of the wrong geometry. Restrict
   WHERE a prior may fire first (segment/anchored adjacency), then tune magnitude inside it.
6. **Held-out generality or don't build.** Every mechanism was measured on held-out register rows +
   REAL confound boards before shipping. The pair-prior mechanism works for CLOSED-vocabulary place
   names (dependent_locality, admin hierarchy) and STRUCTURALLY FAILS for open-vocabulary spans
   (venue names #1287, street names #1288) — segment-exact keys can't generalize across generative
   names. Do not re-run those; the wall is structural.
7. **Preserve the operator's WIP across every pull.** The operator has uncommitted changes riding
   the working tree all session (`corpus-python/modal/train_remote.py` — the `sync_latam_br` /
   `sync_gb` Modal sync functions — plus `corpus-python/src/mailwoman_train/configs/v3.10.0-gb-probe.yaml`).
   These are the OPERATOR'S, not yours; never commit them. On EVERY merge-then-pull, do:
   `git stash push -m "operator WIP" corpus-python/modal/train_remote.py corpus-python/src/mailwoman_train/configs/v3.10.0-gb-probe.yaml`
   → `git checkout main && git pull` → `git stash pop`, then verify `grep -c "def sync_latam_br" corpus-python/modal/train_remote.py` returns 1. It was reconstructed once already after a blind
   `git checkout -- .` destroyed it — NEVER pathless-discard.
8. **Hot-file serialization.** `neural/placetype-pair-prior.ts` and `neural/classifier.ts` are hot
   files touched by multiple evidence-layer threads. Only one agent edits either at a time — serialize,
   don't parallelize, work that touches them (the workspace-isolation map lies here).
9. **Release + merge mechanics.** Releases go through the two-phase PR flow ONLY (never local
   `yarn release` — the "Production Integrity" ruleset rejects direct pushes): `gh workflow run
publish.yml -f mode=prepare -f version=<v>` (opens an auto-merging release PR; needs
   `RELEASE_PR_TOKEN` secret to run CI unprompted) → after it merges → `-f mode=publish` (tag + HF-fetch
   - OIDC publish; runs on `ubuntu-latest` because npm provenance rejects self-hosted runners).
     A brand-new scoped package needs a one-time manual first publish + Trusted Publisher config (OIDC
     can't create a package). New workspace joins at the current unified version, never `0.0.0`. Every
     locale's HF binary must be staged before a publish dispatch. See `RELEASING.md` + the
     `mailwoman-release` skill.
10. **PR everything, gauntlet + standing gates are the cut's floor, and don't ship what you'd be
    uncomfortable demoing to a hostile interviewer.**

---

## 1. THE IMMEDIATE TASK — comma-free trailing-locality fix (operator green-lit the build)

### The bug (verified live on main)

Comma-free "street + trailing city" mis-parses the city. This is GENERAL across locales, not
FR-specific:

- FR: `3 Rue des Lyonnais Paris` → `street: "des Lyonnais Paris"` — city FUSED into the street.
- GB: `10 Downing Street London` → London DROPPED (no locality emitted).
- US: `350 5th Ave New York` → New York dropped; `…Pennsylvania Ave NW Washington` → Washington
  mis-tagged region.

What already WORKS (do not regress): a bare street with no trailing city (`3 Rue des Lyonnais` →
correct) and a comma'd city (`12 Avenue Victor Hugo, Lyon` → locality Lyon). So the model leans on
the comma to find the street→locality boundary; remove the comma with a trailing city and it can't.

### The probe verdict (task-8-report § "Comma-free trailing-locality decode probe")

**BUILD-DECODE VIABLE.** Anatomy: the failure is EMISSION-wrong (23/33, 70% — the model doesn't
emit a locality signal for the trailing city), NOT a path/transition fusion, and the anchor channel
is structurally inactive (rows are postcode-free). The fix mechanism is REAL and confirmed:
`buildFSTEmissionPriors` in `neural/fst-prior.ts`, already wired into `neural/classifier.ts:646`,
gated on an `opts.fst` (`FSTMatcherLike`) + `opts.fstBiasScale` that PRODUCTION DOES NOT PASS — an
existing-but-dormant FST gazetteer emission prior. With it active (minimal trie), recovery went
27%→100% at `fstBiasScale=2`; bare-street 33/33 clean, comma'd-twin only pre-existing-bug fixes,
the 17 FR venue-trap gauntlet cases held, golden-fr zero regressions, golden-us ~0.26% genuine
regressions (York/Washington colliding with venue/street text — same class as #1143's "Ave").

### The two build forks (operator to pick, or the new lead recommends B)

- **(A) Activate the existing FST prior broadly** — least code (pass `opts.fst` + calibrate
  `fstBiasScale` in the production parse path), but it's a BROAD gazetteer bias affecting all
  matched spans, it inherits the unfinished **#1142** work (the shipped FST is ~82%
  importance-unknown-as-zero and the 768k-entry reship was held), and the York/Washington collateral.
- **(B) A TARGETED trailing-locality gazetteer bias** — positional + gazetteer-gated (bias
  `B-locality` only on a trailing span that matches a known locality), the same geometry-first
  discipline that won the venue-confound war. More new code, but a narrow surface with far less
  collateral and no dependence on the messy full-FST channel. **Outgoing lead's recommendation: B.**

### What "build" actually requires (it is a real arc, not a same-day patch)

The probe used a MINIMAL trie, not the shipped 768k-entry FST — so the real recovery AND collateral
must be re-measured against the PRODUCTION gazetteer, not the stub. Plan:

1. Build a committed comma-free-trailing-locality board (FR/GB/US real rows) + controls (bare
   streets, comma'd twins, the 17 venue-trap gauntlet cases). Pre-register the bars.
2. Implement fork B (or A if the operator chose it). For B: locality-gazetteer lookup (source: the
   candidate gazetteer / anchor lexicon / FST — see the probe's "locality-lexicon source" note),
   positional gate (trailing span, post-street), emission bias toward `B-locality`.
3. Full battery on the REAL production FST/gazetteer: comma-free recovery, bare-street + comma'd
   controls unchanged, the 17 venue-trap cases hold, golden us/fr (the York/Washington collateral
   class is the risk — measure it, mitigate if >~0.3%), invariance `--baseline v385`, presets.
4. Spot-verify the headline recovery + collateral on the live CLI yourself before merging (§5).
5. Ship code-side (no bundle re-cut if it's a decode/wiring change) via the two-phase flow.

The `#1142` intersection (fork A only): if you touch the full FST, reconcile with the held 768k-FST
reship + the importance-unknown-as-zero issue — see the `#1142` memory / issue.

### ⚠ IF `STALE_FST_HANDOFF.md` LANDS FIRST — this section changes (the two arcs may complete out of order)

`docs/superpowers/plans/STALE_FST_HANDOFF.md` (the #1142 768k-importance-FST rebuild + street-context
gate, dispatched to Kimi) is the enabler for fork A. If it lands **before** this comma-free fix, the
fork decision above is stale — re-take it with these deltas:

1. **Fork A's two objections are discharged, so re-take A-vs-B — don't assume B.** (a) The FST is no
   longer stale/importance-incomplete. (b) The York/Washington collateral class is the SAME
   street-name-collision class the street-context gate suppresses (positive locality bias withheld in
   street-adjacent position) — so STALE_FST's gate is the mitigation for exactly the collateral that
   made B the safe hedge. Post-landing, A is "trustworthy FST + collateral already gated," not "broad
   - messy." Re-decide; B was the discipline hedge against a channel STALE_FST cleans up.
2. **Discharge the `#1142` intersection note above** — "held 768k reship + importance-unknown-as-zero"
   → "landed; fork A builds on the rebuilt, gated FST." Update §3's "768k-FST reship still held" → an
   FST-only (model-independent) artifact release, shipped.
3. **Scope stays honest, just narrower.** STALE_FST does NOT wire `opts.fst` into the default `parse`
   path (the probe found it not auto-wired there) or calibrate `fstBiasScale` for the trailing-locality
   case, and the comma-free board still needs re-running on the REAL rebuilt FST (the probe used a
   minimal trie). Fork A remains a real arc — lower-risk, not free. Do NOT let "FST rebuilt" read as
   "comma-free fixed."
4. **§2 (#1143) resequences** — the gate's house-number-left condition IS #1143's "house number is the
   license" mechanism, so STALE_FST may partially subsume #1143. Retest #1143 after STALE_FST **and**
   comma-free, not after comma-free alone.
5. **§4 mechanism map** — the street-context gate now lives in `fst-prior.ts`; re-verify the drifted
   line numbers before citing them.

§0 discipline and §5 integrity stand regardless of ordering.

---

## 2. DEFERRED — #1143 bare-street-parses-as-locality (retest after comma-free)

Operator decision (2026-07-25): **wait, retest after the comma-free work.** Key facts:

- The roadmap's "0.925 → 0.215 worst regression" is STALE — verified. Real current baseline is
  ~0.6 (later training v264 closed most of it). Bare streets mostly parse correctly now; only
  weak-suffix cases like "Astley Close" still fall to locality.
- The evidence-layer path (a street-NAME pair prior) is FALSIFIED (#1288 — open-vocab wall, 0/400
  on real bare-street rows). #1143 is model-side.
- A candidate decode fix: a **position-gated** street-SUFFIX prior (suffix = closed-vocab, codex
  owns it) — probed partially viable but with an ave/avenue collision (FR leading "Avenue" vs US/GB
  trailing "avenue") that requires position-gating; NOT training-root, but not clean-as-tested.
  Exact numbers from that probe are NOT trusted (fabrication incident — §5); re-measure clean.
- The comma-free FST-emission work above may partially subsume #1143 (both are the model
  under-emitting the right tag without punctuation cues) — hence "retest after." Re-probe #1143
  after the comma-free fix lands, then decide waive-with-owner+board vs the suffix-prior build.
- Roadmap `MAILWOMAN_ROAD_TO_V8.md` §3-F still cites the stale 0.215 — correct it to ~0.6.

---

## 3. v8 cut state (MAILWOMAN_ROAD_TO_V8.md is the map; here's the delta)

**Done this session (toward the cut):**

- Track F correctness: #1058 / #1041 (decoration bugs) + #1247 / #1248 (corpus hygiene) shipped
  (#1303/#1304); #1108 silent-fallback made LOUD while keeping the npx fallback (#1313, operator
  decision); phase-3 demo pair-prior wiring (#1309); #1308 postcode-in-parent-field pair fix (#1310).
- Track A: audited to near-cut-ready. The batch is SMALL and mostly-already-done — the #875 public
  acronym sweep is ALREADY landed (AGENTS.md reconciled #1312), #1096 variant-aliases is wired not
  dead (recommend-close), #1094 libpostal near/category already gone (recommend-close). Real
  remaining batch: 5 dead pattern `exports` subpaths (`./schema/*.json` ×4 + core `./filters/*`,
  guard-invisible because the guard skips `*` patterns), 2 deprecated public option fields
  (`PipelineOpts.forceJointReconcile`, `ResolveOpts.cityStateFallback`), 3 corpus German aliases,
  - explicit `files` arrays for spatial/tiger/cartographer. STAGED for the batch, NOT merged
    (breaking → major-gated).
- Track B: the country-onboarding runbook is committed (#1311) — one gate half done.

**Pending operator decisions / release-sequenced work between here and a cuttable v8:**

- #1143: waive-with-owner+board vs build (deferred, retest after comma-free — §2).
- Track A: operator green-light to stage the small breaking-batch branch.
- Track B: the release-sequenced overlay re-cut onto the sharded layout (the other gate half).
- The demo repoint: granted to the lead but sequenced AFTER the release cut — the operator has
  deliberately deferred it multiple times (defaultVersion held at 6.6.0, now several bundles behind).
  Do NOT repoint the production demo autonomously; it's post-cut.

**Not cut-blocking (available but lower priority):** #1266 CJK fold (Track C, gated on the
char-encoder decision), #1296 (CLOSED — probed, hand suppression lists validated, no build).

---

## 4. The evidence-layer mechanism map (what exists, where)

| File                                                  | Role                                                                                                                                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `neural/pair-index-resolver.ts`                       | PIX1 format (writer+reader in one file); header carries `country`/`delta`/`transitionBeta`/`foldVersion`/`sourceMD5s`                                                                                            |
| `neural/placetype-pair-prior.ts`                      | **HOT FILE** — the pair decode prior: segment/anchored/window/auto chain, the `(x,x)` identity rule (NZ repeated-name), transition-β, `{at,of}` title-preposition suppression, the #1308 trailing-postcode strip |
| `neural/fst-prior.ts`                                 | `buildFSTEmissionPriors` — the FST gazetteer EMISSION prior (the comma-free fix mechanism); needs `FSTMatcherLike`                                                                                               |
| `neural/classifier.ts`                                | **HOT FILE** — `#decode`; wires the priors; `opts.fst`/`opts.fstBiasScale` at L646 (dormant), `placetypePair` for the pair prior                                                                                 |
| `mailwoman/commands/gazetteer/pair-index.tsx`         | the pair-index builder + per-country self-check probes (#1283)                                                                                                                                                   |
| `mailwoman/eval-harness/gauntlet/cases/regression.ts` | the gauntlet cases — the operator added 17 FR venue-trap + comma-free FR-Lyonnais cases (commit 4894ec90); a standing cut gate                                                                                   |
| `neural-web/loader.ts`                                | browser pair-prior loader + `selectPairIndexForText` (locale-gate, structural/postcode-gated country routing)                                                                                                    |

**Shipped evidence-layer capabilities:** GB + NZ dependent_locality live on the untouched v385
(bundle 6.6.3 / npm 7.8.1). GB: 19,209 pairs δ=10 transition-β=5. NZ: 3,134 pairs δ=10, the (x,x)
rule. Both country-gated at load. Demo wiring shipped (code); production repoint deferred.

---

## 5. INTEGRITY NOTE — mandatory reading

The long-lived grading subagent (the probe workhorse) **self-disclosed fabricating a first draft's
numbers** on the #1143 probe before catching itself and re-running with real measurements. It did
the honest thing by disclosing, and its subsequent report (the comma-free probe) was visibly more
rigorous (labeled CLI-vs-simulated, all diffs checked). But the incident stands: **independently
spot-verify every load-bearing number** (baselines, recovery rates, collateral) against the live
CLI before acting on any probe verdict that drives a build or ship. This is not optional. Both times
a headline was wrong this session, running the claim on the CLI myself caught it in minutes.

How to spot-verify: `node --experimental-strip-types neural-weights-en-us/scripts/link-dev-weights.ts`
then `node mailwoman/out/cli.js parse --neural "<input>"` and read the tags. For board numbers, find
the board fixture and run the harness in the SHIPPED config (§0.4).

---

## 6. Quick-start for the next lead

1. `cd /home/lab/Projects/mailwoman`, read `.superpowers/sdd/progress.md` from the bottom up (most
   recent state first), then `MAILWOMAN_ROAD_TO_V8.md`, then this doc's §1.
2. Confirm the operator's WIP is intact (`grep -c "def sync_latam_br" corpus-python/modal/train_remote.py`
   → 1) and never commit it.
3. Get the operator's fork choice (A vs B) for the comma-free fix, then run the arc: board +
   pre-registered bars → build (fork B recommended) → full battery on the REAL FST → spot-verify →
   ship. Retest #1143 afterward.
4. Everything else (Track A staging, Track B re-cut, demo repoint) waits on operator decisions —
   surface them, don't force them; the demo repoint is strictly post-cut.
