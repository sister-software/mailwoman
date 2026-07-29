# v8.3.0 Phase-0 memo 2 — Fisher capture design (D4)

**Resolves:** ROAD_TO_MAILWOMAN_V8_3_0 §4 D4 + §6. The consolidation artifact that makes
"your fine-tune cannot break core parsing" a gate instead of a hope (the B11 guarantee).

## What is captured

**Diagonal empirical Fisher** over the base training distribution: `F_i = E[(∂L/∂θ_i)²]`,
estimated as the running mean of squared per-parameter gradients over the final N batches of the
base run (proposed N = 2,000 batches ≈ the last ~2k steps' micro-batches — the converged-model
regime, which is what EWC's quadratic approximation assumes). Diagonal-only (D4 default):
blockwise buys accuracy the first consumer can't yet use and multiplies storage; revisit if λ
calibration shows the diagonal is too blunt.

**Per-locale slices: not in v1.** One Fisher over the full feed. A per-locale family
(F_us, F_fr, …) enables "protect only what this customer doesn't touch" later — file it as the
v2 refinement once a real engagement asks for it.

## Implementation (training-side, small)

- `train.py`: a `fisher_capture: {enabled, last_n_batches}` config block; during the capture
  window, accumulate `grad²` per parameter (one extra fp32 buffer, ~116 MB GPU memory at 29M
  params — fits trivially); at save time write `fisher-diag-v1.npz` beside the checkpoint
  (param-name → array, same keying as the state dict).
- **The rng/byte-stability rule** that every curriculum obeyed: capture reads gradients the
  optimizer already computed — zero effect on the training trajectory, byte-identical run with
  the flag off or on.
- `export`: the artifact converts to **fp16 (~58 MB)** for distribution. Precision receipt: EWC
  penalties use Fisher _relative_ magnitudes; fp16's 3 decimal digits are ample. If 58 MB is
  unwelcome in the npm tarball, ship it **HF/R2-only** (the wof-polygons precedent — fetched by
  the training/fine-tune tooling, not the runtime; the runtime never reads Fisher).

## Consumption (the fine-tune recipe template)

- `train.py`: `ewc: {fisher_path, lambda}` — adds `λ/2 · Σ F_i (θ_i − θ*_i)²` to the loss, with
  `θ*` the base checkpoint. ~30 lines next to the existing loss assembly.
- **λ calibration, once, on our own next fine-tune** (the first post-base increment, whatever it
  is): sweep λ ∈ {0, 1e2, 1e4, 1e6} on a 2k-step probe; pick the largest λ that leaves the
  increment's target metric within noise of λ=0. That λ becomes the template default; a customer
  engagement inherits it and only revisits on a battery failure.
- **The guarantee gate** (the sellable sentence): a Fisher-protected fine-tune must hold every
  base capability within the noise-honest margins on the packaged battery. Base capabilities =
  the golden floors + the P0 fragment bars + the gauntlet; the customer's own canaries ride
  alongside. A gate failure at the calibrated λ is a _finding about the customer data_, surfaced
  before delivery — which is the product working, not failing.

## Contract + provenance

- `fisher-diag-v1` joins the weights-bundle artifact family: versioned filename, md5 in the
  model card's `files_md5` (HF-staged; npm optional per above), captured-at metadata (run id,
  step window, feed hash) in an `.json` sidecar — the same provenance discipline as the lexicons.
- The release-hf command + publish.yml preflight gain one file each (the mechanical pattern from
  the lexicon additions; noted in ROAD_TO §9 so it isn't forgotten at the cut).

## What this deliberately does not claim

EWC protects against drift in _parameter space_, calibrated on _our_ distributions. It does not
guarantee arbitrary customer data can't find a pathological direction — that is what the battery
gate is for. The two together (parameter-space brake + behavior-space gate) are the honest
guarantee; neither alone is.
