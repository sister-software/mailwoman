# Night 6 postmortem — 2026-06-05 (CJK arena: Japan lands)

**Window:** 04:18 → 14:00 UTC. **Modal budget:** $15 (~$13 used: two A100 runs + exports). **Status:** final.

## What shipped

- **#292 — Japan coarse resolution (PR #303, merged).** The first CJK locale, and it validated the whole arena architecture. WOF has no municipality polygons in CJK (point geometry, confirmed JP/KR/TW), so the European point-in-polygon build is inapplicable (~25% JP). Pivoted to an authoritative **name-match** build (KEN_ALL romanized municipality + GeoNames point → cross-placetype WOF match) feeding the _same_ `postcode_area_resolution` strategy with zero new resolver code. **Build 94.9%, end-to-end resolver 98.5% (KEN_ALL gold) / 93.9% (independent GeoNames cross-check)**, all above the 85% bar. EU (DE/FR/GB/NL) byte-identical after the merge.
- **CJK arena eval report (PR #304, merged)** — `docs/articles/evals/2026-06-05-cjk-arena.md`, plus the Direction-E design-doc correction (it had assumed PIP was uniform).
- **CJK provenance in the build manifest (PR #307)** — pinned the JP WOF repo commits + KEN_ALL fetch chain + GeoNames points source (reproducibility / build-from-source discipline).
- **Two v0.8.0 training experiments** (configs #306 ls=0.05, #308 bare-street + the `bareProb` corpus feature) — run, evaluated, **neither promoted** (verdict below). The durable wins: the harness failure analysis (143 targetable vs 175 blocked) and the reusable `bareProb` synthesizer.
- **Issues:** filed #305 (the exact-tier/conflict-flag design question); logged KR (#293) + TW (#294) data blockers; groomed #14 (Japan milestone).

## Training verdict (both runs — NEITHER promoted; v0.7.2 stays default)

|                 | per-tag gate                                                                    | harness                                                                                                 | verdict                                                                                          |
| --------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **ls=0.05**     | postcode +4.2pp, but street −4.1 / venue −4.5 / house_number −2.4 (3 tags >2pp) | +1.6pp (20.2%)                                                                                          | **not promoted** — calibration trades postcode for street/venue; fails the gate, not significant |
| **bare-street** | street −2.8pp (golden full-address streets shifted)                             | +0.9pp (19.5%); **usa +7pp** (22→29%) but **functional 2/34→1/34 — target missed**; net not significant | **not promoted** — redistributes (US harness up, golden street down), fails the gate             |

**The honest answer to "can we deliver a v0.8.0 harness breakthrough tonight?": no, with the safe levers.** Calibration trades tags; the bare-street shard helped US contexts but missed its functional target and regressed golden street. The real harness gap is the **175/318 untrained-locale failures** (the multi-locale PARSER problem), which is the unsolved German-end-of-string-collapse direction — not something to brute-force autonomously. The two runs are clean, informative data points (the ls=0.05 fork is now answered; the bare-street weight 0.2 over-shifts), but v0.7.2 remains the right default. **The shift's real model win is the JP RESOLVER, not a new parser.**

## Experiments + baselines

- **ls=0.05** (`ap-VMb3...`) and **bare-street** (`ap-hzrf...`) — both 100k steps on A100, detached, concurrent, exported + evaluated. Verdict above; neither promoted.

  **v0.7.2 baselines (the current default, kept as default):**
  - Harness (the operator's "v0 test-suite coverage"): **neural 18.6%** pass (77/415) vs v0 93.7%; both-pass 17.1%, v0-only 76.6%, neural-only 1.4%. Per-file: usa 22%, intersection 17%, functional 6%, fra 33%, nld 9%.
  - Per-tag golden (the pre-publish gate): exact-match 31.4%; locality 39.1%, region 64.9%, postcode 79.3%, street 47.8%, house_number 80.5%.
  - Differentiators: the 22 falsehoods in the harness (`/tmp/v072-harness.json`).

- **bare-street** (#308) — the harness lever, from the analysis below. Val macro_f1 0.81. Result: usa +7pp but functional target missed, golden street −2.8pp → not promoted (verdict above).

**ls=0.05 calibration — DONE, NOT PROMOTED (the staged fork is answered).** Per-tag vs v0.7.2: postcode **+4.2pp** (calibration's win) but **street −4.1, venue −4.5, house_number −2.4** (three tags regress >2pp → fails the pre-publish gate). Exact-match flat (31.2 vs 31.4). Harness +1.6pp (20.2% vs 18.6%) — real but not "significant," and the per-tag regressions disqualify it anyway. Verdict: ls=0.05 trades postcode for street/venue, net not a clean win; calibration is not the v0.8.0 lever. The fork the operator staged is closed.

**The harness analysis that drove the second run.** Broke down the 318 v0-only harness failures (where v0 passes, neural fails):

- **143 in-distribution** (US / intersection / functional) — **safely targetable.** The `functional.test.ts` cluster (32/34) is bare street names (`10th Ave`, `Main St`, `1 Main Pl`) mislabeled `locality`, because `synthesizeStreetRow` only ever emitted streets with a `, City, ST ZIP` tail. → the **bare-street shard** (#308): teach bare streets → street, the bare-format analogue of intersection-bare. Potential ~+5-8pp toward the 25% bar, no German-collapse risk.
- **175 untrained-locale** (deu 17/17, nzd 22/22, nld 20/22, place.fra 13/13, …) — **BLOCKED.** v0.7.2 trains US+FR only; these locales fail because they're out-of-distribution. Covering them is the multi-locale PARSER problem, which is the known-unsolved German-end-of-string-collapse direction (the v0.8.0 order-shard reverted for exactly this). **Not attempted autonomously** — it needs the anchor-based / collapse-fix work, not a naive retrain.

  So the honest answer to "can we move the harness tonight?": **the safe lever (calibration) can't** (adds no coverage); **the bare-street lever can, partially** (the in-distribution cluster); **the big gap (untrained locales) is blocked** on unsolved parser work.

**Both runs were exported + evaluated** (per-tag `eval-error-analysis.ts` + `harness-v0-neural.ts` vs the v0.7.2 baselines). Neither cleared the promote gate (harness ↑ meaningfully AND no tag −2pp) — verdict table above. v0.7.2 stays the default; nothing uploaded to HF.

## What went well

- **Probe-before-build paid off twice.** Quantifying the point-geometry wall (25%, then the cross-placetype jump to 94.9%) before committing a production build avoided shipping a broken recipe — and the cross-placetype insight (JP municipalities split across `locality`/`county`/`localadmin`/`borough`) was the whole unlock.
- **The convention engine earned its keep exactly as designed** — JP is a _different build_ (name-match) feeding _one unchanged resolver_. No special-casing.
- **Independent cross-check (GeoNames vs KEN_ALL)** kept the headline number honest (93.9%, non-circular).
- **Byte-stability discipline** caught nothing because nothing broke — every shared-asset merge was guarded and the EU dump stayed identical.

## What could've gone better

- The exact-name-tier "fix" (#305) looked like a quick win and turned out to entangle with the conflict-flag design — caught it by reading the code before implementing, but it cost a detour.
- KR/TW stalled on external data (gov sites geo/login-walled, no GeoNames TW) — logged-and-pivoted per plan, no spin, but the arena only advanced one locale tonight.

## Decisions made autonomously

- **Launched the ls=0.05 run early** (06:00, not the planned 12:00 gate) to maximize eval/react time, since the config was a clean single-variable fork reusing v0.7.2's exact corpus + tokenizer (low risk). Honest expectation logged: unlikely to clear the "significant harness gain" bar; run as a data point closing the staged fork.
- **Launched the bare-street run** (concurrent, second A100) after the harness analysis showed a clean in-distribution lever — and committed it (#308) before knowing the result. Honest call: a real, safe shot at the operator's harness goal; it didn't pan out, but the analysis + the `bareProb` feature are durable.
- **Did NOT attempt the multi-locale parser retrain** (the 175/318 untrained-locale failures) — that's the unsolved German-collapse direction, the wrong thing to brute-force in an autonomous session.
- **Did NOT promote either run** — both fail the per-tag >2pp gate and neither is significant. Default to don't-ship; v0.7.2 stays.
- **Deferred #305, KR/TW** rather than spin on walled data / a byte-stable-path risk.

## Open questions for the operator

- **The v0.8.0 harness goal is blocked on the multi-locale PARSER problem.** The safe levers (calibration, bare-street) can't deliver "significant harness improvement" — 175/318 v0-only failures are untrained locales (deu/nzd/nld/…), and covering them re-triggers the German end-of-string collapse. This is the real next prize and it needs the anchor-based / collapse-fix work, not another shard. Worth a focused (non-autonomous) push?
- **#305:** name-wins-and-flag (current) vs postcode-wins when the exact-name is cross-region? Affects EU byte-stability — your call.
- **KR/TW:** worth the manual fetch (KR Juso romanized / TW Chunghwa Post) the way you fetched KEN_ALL, or shelve CJK at Japan for now?

## Concrete next steps

- **bare-street follow-up (cheap):** weight 0.2 over-shifted (usa +7pp but golden street −2.8pp). Retry at **0.1** — likely keeps the US gain with less golden regression. And investigate _why_ the functional cluster didn't move (2/34→1/34) despite the shard — possibly a tree-structure check, not just the bare-format label.
- **KR coarse** once a romanized authoritative source is in hand (`build-postcode-locality-cjk.py` already generalizes via `--country`).
- **TW:** admin-DB rebuild to add `admin-tw` (clone on disk) + a TW national postal source.
- **#305** design decision → careful PR with the full EU resolver-eval guard.

## Numbers

|                      |                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------- |
| shift window         | 04:18 → (ongoing) UTC                                                                    |
| PRs merged           | #303 (JP), #304 (CJK report), #306 (ls=0.05 config), #307 (manifest), #308 (bare-street) |
| issues filed/updated | #305 filed; #293/#294/#14 commented                                                      |
| models trained       | 2 (ls=0.05, bare-street) — **neither promoted; v0.7.2 stays default**                    |
| Modal cost           | ~$13 / $15 (2× A100 ~1.8h each + 3 exports)                                              |
| NaN incidents        | 0                                                                                        |
| CI failures          | 1 (transient registry-network flake on #304, re-ran green)                               |
| regressions shipped  | 0 (EU byte-identical; nothing promoted)                                                  |
