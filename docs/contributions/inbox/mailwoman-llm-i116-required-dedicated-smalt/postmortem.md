# Postmortem — issue #116 v0.4.0 ship

## Outcome

v0.4.0 shipped to packaged artifacts (no npm publish per standing rule).
Cleanest available recipe — §4 source rebalance only on top of v0.3.0
dual-loss base. Mixed result vs v0.3.0 on golden: street +0.03 / house_no
+0.01 / country -0.07 / postcode -0.07. Issue #116 success metric not
cleanly met. Followup scoped as v0.4.1.

## What worked

- Iterative ablation framework — LR bisect → §1/§3 ablations → stable-LR
  matrix. Each round halved the hypothesis space and produced a clear
  signal even when the recipes failed.
- Categorized post-hoc diagnostic (now `corpus-python/scripts/diagnose_regression.py`)
  turned the headline "regression of -0.07" into actionable per-bucket
  proportions. Surfaced that 65% of postcode FN is `empty_pred` and 92%
  of country FN is `non_latin` — both completely change the v0.4.1
  scope vs the first-pass intuition.
- Outbox + checkpoint protocol kept the host-claude operator surrogate
  informed enough to delegate (npm gate, decoder span-trim sidecar) and
  unblock me when the v0.4.1 scope was operator-only.
- Wrapper script's auto-resume-on-GPU-hang absorbed multiple firmware
  hangs cleanly; never blocked iteration.

## What didn't

- The verdict-smoke framework gave a false-positive PASS on cw-only:
  max_steps=3000's cosine schedule decayed LR to near-zero by step
  2750, masking the sustained-peak-LR divergence that hit at step 2250
  of the full 50000-step run. **Burned ~1 hour of GPU time on this**
  before catching it. Should be documented in
  `docs/articles/plan/reference/VERDICT_SMOKES.md` (or equivalent) so
  the next iteration doesn't repeat.
- Two pre-existing failing tests (`pipeline-debug-cli.test.ts`) had
  been on `main` for over a day before I picked them up. Pre-merge
  smoke wasn't catching them.
- §1 per_token CRF normalization hypothesis was empirically false at
  every LR. Should have been challenged earlier with a gradient-norm
  measurement rather than assuming the per_token normalization math
  worked through to the dual-loss balance.
- PyYAML 1.1 `5e-4` → string parse was a half-hour detour. Defensive
  `_coerce` in config.py landed but should have been caught by the
  config-side tests earlier.

## Tools / permissions missing

- Container couldn't fetch the host-claude's named commit `5566cd2`
  (corpus-audit ship). Either the commit hasn't synced yet or it's on
  a remote not visible from inside. Noted in draft; not blocking.
- A "verdict-smoke" framework that's actually predictive of sustained-
  training behavior. The current max_steps=3000 cosine smoke is too
  short to expose the LR-peak-band destabilization. v0.4.1 should
  redesign with either constant-LR or much longer max_steps.

## What would help next loop

- A `mailwoman corpus-audit` for per-adapter gradient-norm distribution
  during training (not just static shard counts) — would diagnose the
  §1 instability root cause faster than the LR-bisect approach I took.
- A `--smoke-mode` flag on the trainer that runs the actual LR
  schedule's peak-band sustained, separately from the cosine envelope.
  E.g. `train --smoke-mode peak-only --max-steps 3000` would keep LR
  at peak for the entire window.
- Decoder span-trim shipping to main is the right scope for the host —
  good division of labor on the runtime sidecar work that doesn't need
  retraining.
