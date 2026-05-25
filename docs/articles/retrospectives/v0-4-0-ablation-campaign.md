---
sidebar_position: 2
title: v0.4.0 ablation campaign
---

# v0.4.0 ablation campaign

**Iteration window**: 2026-05-23, ~9 hours wall-clock, single Radeon 780M iGPU. **Outcome**: shipped a smaller subset of the planned recipe than intended; identified one process meta-bug; deferred two of three training-side improvements to v0.4.1.

This is the technical postmortem. For the public-facing narrative, see the corresponding [blog post](pathname:///blog/2026-05-24-bisect-by-elimination). For the line-by-line iteration log entry, see [PHASE_2_training.md's v0.4.0 entry](../plan/phases/PHASE_2_training.md).

## Setup

- Model: 256-dim, 6 layers, 4 heads, intermediate 1024, max_pos 128 — 9M params total. Unchanged from v0.3.0.
- Corpus: `corpus-v0.3.0` (677M aligned rows). Unchanged from v0.3.0.
- Tokenizer: v0.1.0 sentencepiece. Unchanged from v0.3.0.
- Label vocab: 21 BIO classes. Unchanged from v0.3.0.
- Hardware: gfx1103 Radeon 780M iGPU, batch=32, grad_accum=4 → effective 128, ~4.5 steps/sec sustained.

The only intended differences from v0.3.0 were:

- **§1** `model.crf_normalization: per_token` (was implicit `per_sequence`) + `crf_loss_weight: 1.0` (was 0.05).
- **§3** `model.class_weights: {O: 1.0, B-country: 2.0, ..., B-venue: 0.5, ...}` (was uniform).
- **§4** Source weights rebalanced: `usgov-nad: 2.0 → 1.0`; `wof-admin: 1.0 → 2.0`; `wof-postalcode: 1.0 → 2.0`.

§2 (longer training to step 5000+ floor) and §5 (JS-side Viterbi + model-card label loading) were process improvements, not loss-surface changes. §5 had shipped before training. §6 was "reuse existing corpus" — non-action.

## Run-by-run

### Run 1 — full recipe, lr=5e-4

`configs/v0_4_0.yaml`. lr=5e-4 had been the v0.2.0 baseline before v0.3.0's dual-loss instability forced it down to 1.5e-4. The §1 hypothesis was that per-token CRF normalization would make `crf_loss_weight=1.0` safe at 5e-4 again.

Diverged step 750. Training loss had dropped monotonically 6.5 → 0.3 over steps 0-700, then spiked 0.3 → 3.3 over steps 700-1000. Val macro-F1 collapsed 0.36 → 0.11. Killed via `train_with_resume.sh` interrupt; checkpoint at step-500 (best so far) preserved at `/data/models/checkpoints/v0_4_0/step-000500`.

### Run 2 — full recipe, lr=3e-4

`configs/v0_4_0-lr3e4.yaml`. Operator brief said "if divergence recurs by step 2000, bisect down."

Diverged step 1000. Same fingerprint. Step-750 checkpoint at macro_f1 0.37 preserved.

### Run 3 — full recipe, lr=1.5e-4 (v0.3.0-stable LR)

`configs/v0_4_0-lr1.5e4.yaml`. By this point the bisect pattern was visible: 5e-4 → step 750, 3e-4 → step 1000. A pure-LR explanation predicted lr=1.5e-4 → step 1875 (linear) or ~step 2200 (proportional). It diverged at step 2000.

A factor-3.3× LR drop bought a factor-2.7× step delay. Sub-linear — confirming that LR controls _when_ the divergence appears but isn't the root cause. The destabilizer is in the recipe, not the LR knob. Step-1250 checkpoint at macro_f1 0.39 preserved.

### Runs 4 & 5 — ablations at lr=5e-4

`configs/v0_4_0-ablate-crf.yaml` (drop §1, keep §3+§4) and `configs/v0_4_0-ablate-cw.yaml` (drop §3, keep §1+§4). Per the issue's prescribed ablation matrix.

Both diverged at step 1000, identically. At lr=5e-4 every single-knob revert behaved like the full recipe.

**Conclusion**: lr=5e-4 is structurally unreachable for this codebase's dual-loss landscape regardless of which §1/§3 knob is active. Pivot to the stable LR.

### Runs 6-8 — stable-LR verdict smokes at lr=1.5e-4

Three orthogonal cells, `max_steps=3000` cosine schedule:

| Run | Recipe                               | Verdict |                      Peak macro_f1 | Drift (last 5 evals) |
| --- | ------------------------------------ | ------- | ---------------------------------: | -------------------: |
| 6   | source-only (§4 only)                | PASS    |                             0.4190 |                0.005 |
| 7   | cw-only (§3 + §4, v0.3.0 CRF base)   | PASS    |                             0.4279 |               0.0036 |
| 8   | crf-only (§1 + §4, no class_weights) | FAIL    | n/a (train_loss=1.24 at step 3000) |                  n/a |

cw-only looked like the clear winner — higher peak, lower drift, both under the 0.10 collapse threshold.

### Run 9 — promote cw-only to full 50K

`configs/v0_4_0-final.yaml`, identical to `cw-only` but with `max_steps=50000` and a fresh `output_dir`.

Diverged at step 2250. Same fingerprint as the full recipe at lr=1.5e-4. The smoke had been a false-positive.

### Run 10 — fall back to source-only at full 50K

`configs/v0_4_0-stableLR-source-only.yaml` with `max_steps=50000`.

Survived. Peak macro_f1 0.42 at step ~2200; gradual cosine-decay decline through the rest. Step-2200 checkpoint became the shipped artifact: `v0_4_0-stableLR-source-only/step-002200`.

## The meta-bug

cw-only's smoke (3000 steps, cosine schedule) had its LR back near zero by step 2750. The "pass" criterion ("macro*f1 stable across the last three evals past step 2000") was measuring stability \_under a decayed-to-near-zero LR*. The full 50K run kept the LR near its 1.5e-4 peak for thousands of steps. That sustained-peak exposure was where the destabilization happened in every other run too.

The smoke wasn't testing the same loss landscape as the full run. The cosine schedule's tail had been doing the heavy lifting of "stability" all along.

**Process fix for future smokes**:

- Constant LR for the verdict window, OR
- max_steps large enough that the cosine tail doesn't dominate. With warmup=1000 + cosine=N, the LR is > 60% of peak roughly through step `warmup + N/3`. Picking max_steps so the verdict window sits in that range (e.g. 10000 keeps LR > 60% peak through step ~4300).

## Math sanity-check

Before deferring §1 and §3 we audited `model.py` and `crf.py` for implementation bugs that could explain the destabilization:

- `crf.py:155-164` — the `per_token` reduction is `nll.sum() / total_tokens.clamp(min=1)`. Mathematically what the docstring claims. No NaN-prone path; the `.clamp(min=1)` guards the empty-batch edge case.
- `model.py:270-300` — class_weights enter via `nn.functional.cross_entropy(..., weight=class_weights)`. The PyTorch-standard path. No silent broadcast mismatch (`class_weights.shape == (num_labels,)` is asserted in the model constructor).
- Dual-loss fusion: `loss = ce_loss + self.crf_loss_weight * crf_loss`. Equal-weight summing at `crf_loss_weight=1.0` with `per_token` reduction was the §1 hypothesis. The hypothesis was that per-token normalization brings CRF NLL to CE magnitude. Empirically, when §1 is active, training destabilizes — so either per-token CRF NLL is NOT actually comparable to per-token CE on this corpus, or the magnitude comparison is right but some other dynamic dominates.

No implementation bug found. The destabilization is a real recipe interaction.

## Post-hoc regression diagnostic

After shipping, we ran a categorized per-tag FP/FN analysis on the shipped checkpoint against golden v0.1.2 (4535 entries). Tool: `corpus-python/scripts/diagnose_regression.py` (in tree from this iteration).

### Postcode FN (1217 total)

| Category     | Count | Share | Pattern                                    |
| ------------ | ----: | ----: | ------------------------------------------ |
| empty_pred   |   789 |   65% | `Paris 75008` → no postcode in output      |
| non_latin    |   213 |   18% | `バー, 47110 サント` → byte-fallback noise |
| num_confused |   136 |   11% | `47110 SLL, 22 Rue Jasmin` → predicts `22` |
| bio_slip     |    73 |    6% | `LE TRÉPORT, 76470` → `", 7647"`           |
| other        |     6 |  0.5% | —                                          |

**Empty-pred dominates**. §4's NAD downweight (2.0 → 1.0) removed the dominant source of "postcode comes first" patterns (NAD's 57M structured 911-grade rows + many FR mid-position patterns from auxiliary sources). The model now treats mid-position numeric tokens as house_number by default.

### Country FN (194 total)

**178 of 194 (92%) are adversarial transliteration entries** — gold has English country names but raw input contains mixed CJK/Cyrillic/Armenian script. Examples:

```
بار نون وایومینگ, Wyoming, United States of America   →  pred: "yoming, United Sta"
サーモポリス, WY, United States of America              →  pred: ", WY, United State"
France, Lozère, ՍԵՆՏ-ԱԼԲԱՆ-ՍՅՈՒՐ-ԼԻՄԱՆՅՈԼ              →  pred: "" (empty)
```

This is v0.3.0's documented non-Latin-byte-fallback failure mode. The v0.4.0 weights did not regress this slice; the eval suite is counting v0.3.0's known failure modes against v0.4.0. After excluding adversarials, country FN drops 194 → ~16.

**The country −0.07 F1 regression is mostly a golden-set adversarial-weighting artifact, not a real recipe regression.**

## The decoder sidecar

The bio_slip slice (6% of postcode FN) is a decoder bug, not a model bug. The model's BIO tag attribution is correct; the emitted span includes leading/trailing punctuation tokens. Fixed in `core/decoder/build-tree.ts` (commit `c72ab4c` on main):

```ts
function trimBoundary(raw: string, start: number, end: number): { start: number; end: number } {
	let s = start,
		e = end
	const isWordChar = (i: number): boolean => /[\p{L}\p{N}]/u.test(raw[i] ?? "")
	while (s < e && !isWordChar(s)) s++
	while (e > s && !isWordChar(e - 1)) e--
	return { start: s, end: e }
}
```

Both `node.value` and `node.start`/`node.end` trim in sync so consumers slicing `raw[start:end]` get the same string as `node.value`. Spans that trim to empty (all-punctuation, pathological model output) are dropped. Word-internal punctuation (hyphens in `Sainte-Livrade-sur-Lot`, accents in `Montréal`) is preserved. 6 new boundary-trim tests pass; full repo suite (1592 tests under singleFork + 30s timeout) green.

## What deferred to v0.4.1

§1 (per-token CRF norm) and §3 (class weights) both deferred. Both individually broke training in at least one tested configuration. The leading hypothesis at this iteration's boundary is that a high-variance adapter slice in `corpus-v0.3.0` produces gradient spikes the per-token-normalized CRF can't dampen — a `corpus-audit` + gradient-norm probe pass per source-id would surface a candidate.

v0.4.1 thread proposals (drafted in [`PR i116 body`](https://github.com/sister-software/mailwoman/tree/issue-116-phase-2-x-v0-4-0)):

- **Thread A** — source-weight tweak (NAD 1.0 → 1.5 partial restore) + synthesis pass over component-order permutations + case-norm eval. Targets the 65% empty_pred slice. 1-2 days.
- **Thread B** — corpus-side gradient-norm probe per source-id. Find the high-variance adapter. 3-5 days.
- **Thread C** — verdict-smoke framework redesign (constant-LR) + milder class_weights ratio. 1-2 days.

## Process improvements landed during the iteration

Six items from the [TODO.md parallel-work list](https://github.com/sister-software/mailwoman/blob/main/TODO.md) shipped to `main` during the GPU-bound training windows (host-claude worked them in parallel):

| Commit    | What                                                                                   |
| --------- | -------------------------------------------------------------------------------------- |
| `ceb2c1f` | `@mailwoman/locale-gate` workspace — Stage 2 of the runtime pipeline                   |
| `58eee3b` | `mailwoman parse --candidates <N>` — Springfield-class disambiguation surface          |
| `5566cd2` | `corpus-audit` tool — shard distribution × source_weights diagnostic                   |
| `150c7db` | runtime-pipeline test hardening (AbortSignal, timing-budget, non-graceful failure)     |
| `d94261b` | `mailwoman parse --benchmark <N>` — per-stage p50/p95/p99                              |
| `c1f82ac` | `docs/articles/concepts/staged-pipeline-contract.md` — "how to plug in a custom stage" |

Plus the decoder sidecar (`c72ab4c`) and the PHASE_2 iteration-log updates (`6ddc170` / `d499288` / `09d0d9f` / `404cceb`).

## Numbers reference

Final eval, shipped checkpoint vs v0.3.0, golden v0.1.2:

| Tag          | v0.4.0 | v0.3.0 |     Δ |                       With adversarials excluded |
| ------------ | -----: | -----: | ----: | -----------------------------------------------: |
| country      |   0.21 |   0.28 | −0.07 |                             ~−0.01 (nearly flat) |
| region       |   0.19 |   0.18 | +0.01 |                                          similar |
| locality     |   0.27 |   0.27 |  flat |                                          similar |
| postcode     |   0.69 |   0.76 | −0.07 | similar (the regression is real, NAD downweight) |
| venue        |   0.39 |   0.39 |  flat |                                          similar |
| street       |   0.30 |   0.27 | +0.03 |                                          similar |
| house_number |   0.79 |   0.78 | +0.01 |                   similar (issue #57 floor held) |

Macro F1 raw: 0.357 vs 0.293. Token confidence: 0.806 vs 0.857. Full-parse exact match: 0.082 vs 0.107.

Issue #116's "≥2 of 4 axes improved" metric: only fine F1 cleanly improved (street +0.03, house_number +0.01). Coarse F1 is mixed once adversarial denominators are excluded. Calibration flat. Training stability negative (the central finding of the campaign).

## See also

- [Blog post](pathname:///blog/2026-05-23-v0-4-0-ablation-campaign) — public-facing writeup
- [`PHASE_2_training.md` v0.4.0 entry](../plan/phases/PHASE_2_training.md) — canonical iteration log
- [Issue #116](https://github.com/sister-software/mailwoman/issues/116) — original work plan
- `corpus-python/scripts/diagnose_regression.py` — categorized FP/FN bucketer (in v0.4.0 branch)
- [`PR i116`](https://github.com/sister-software/mailwoman/tree/issue-116-phase-2-x-v0-4-0) — 10 commits with the campaign artifacts
