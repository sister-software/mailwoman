# Modal retrain launch — runbook

Notes for whoever (agent or human) launches a training run on Modal. Read this before touching
`train_remote.py` or kicking a retrain. The flow has several non-obvious failure points; each gotcha
below has cost a run or hours.

## The flow, in one line

Corpus + configs + tokenizer live in Cloudflare R2 (`mailwoman-assets`) → a **container-side `rclone`**
in a `sync_*` function pulls them into the `mailwoman-training` Modal Volume (`/data`) → the training
reads from the volume. The local `.env` carries the R2 creds (`RCLONE_S3_*`); `train_remote.py` loads it
itself, so `source .env` before `modal run` is not required (but IS required for local `rclone`).

## ⚠️ `modal volume put` is BLIND — never use it for the corpus

Files written via `modal volume put` are visible to `modal volume ls/get` but **NOT to a mounted
training container**, and `vol.reload()` does not bridge it (verified 2026-06-12 with a marker file).
Everything must go through **R2 → a container-side `rclone` in a `sync_*` function → `vol.commit()`**.

## Launching a retrain (the v1.6.0-boundary-stress example)

1. **Build the corpus locally** — for an overlay (base + your new shard), assemble the overlay manifest.
2. **Re-root the manifest paths to `/data`.** The data loader (`data_loader.py`) reads each shard's
   manifest `path` AS-IS; base shards must point at `/data/corpus/versioned/<base>/…` (where the base
   `sync` lands them), NOT the local `/mnt/playpen` build path. The overlay assembler does this
   (`_reroot`). **Verify: `python -c "...; sum('/mnt' in s['path'] for s in shards)"` must be 0.**
   _This bit us on v1.6.0: the manifest's 690 base shards pointed at `/mnt/playpen`, so on the volume
   the loader would re-root them under the OVERLAY dir (which holds only the new shard) and find nothing._
3. **Push the deltas to R2.** `set -a; source .env; set +a` then
   `rclone copy corpus-python/src/ :s3:mailwoman-assets/corpus-python/src/ --exclude "**/__pycache__/**"`
   (delivers the new config) and `rclone copy <overlay-dir>/ :s3:mailwoman-assets/corpus/<ver>/<corpus>/`.
   R2 intermittently returns **501** — ride it with `--low-level-retries 30 --retries 8` (each op
   succeeds on a retry). **Pass rclone flags inline, not via a shell variable** — zsh doesn't word-split
   unquoted vars, so `$FLAGS` arrives as one bogus flag.
4. **Add a `sync_v0XX`** to `train_remote.py`, mirroring `sync_v050`: rclone `corpus-python/src/` (the
   config) + the overlay corpus; `shutil.rmtree` the stale `…/mailwoman_train/__pycache__`; `vol.commit()`;
   then print a verify block (`os.path.isfile` on the config, the MANIFEST, your shard, AND a re-rooted
   base shard). The base + tokenizer usually persist on the volume from prior runs — don't re-sync the
   ~30 GB base unless it's actually missing.
5. **Run the sync:** `modal run scripts/modal/train_remote.py::sync_v0XX`. Confirm every verify line is `True`.
6. **Tokenizer:** confirm the recipe's `tokenizer_dir` already exists on the volume (`modal volume ls
   mailwoman-training models/tokenizer`). Re-using the base run's tokenizer keeps it OUT of the variable
   set; a new tokenizer is a separate, intended change.
7. **Launch the GPU train (the real spend):**
   `modal run -d scripts/modal/train_remote.py --config <recipe>.yaml --resume none` (detached; A100).
8. **Sanity-check the loss in the first ~300 steps — BEFORE walking away.** `modal app logs <app-id>`;
   `train_loss` must be a normal CE scale (O(1–10)) and **decreasing**. An exploded loss (thousands /
   millions, not falling) means a loss term is `-inf`-ing gold labels. _This bit v1.6.0: the conventions
   loss-mask (rider) forbids FR `street_prefix`, which the boundary shard's fr-prefix shape TEACHES → loss
   ~7M. Killed at step 2000, disabled the mask, relaunched (loss 5.0→1.6)._ Don't bundle a per-locale
   label/transition mask with a shard that teaches a label that locale's convention forbids — reconcile
   the convention table with the actual training labels first.
9. **Watch the gate:** the recipe's pre-registered gate is canonical — targets move up, non-regression
   floors hold. A below-bar number is a MISS to confront (re-baseline with a stated reason, or iterate),
   never a quiet pass. Restating a bar from memory drifts it.

## Stale `__pycache__`

A container-side write of new `.py` over old leaves stale `.pyc` that imports instead (the night-3 pyc
gotcha). Every `sync_*` clears `…/mailwoman_train/__pycache__` before `vol.commit()`.

## Recovering

The Volume persists across runs (outputs under `/data/output*`). A failed train doesn't corrupt the
synced corpus, so re-launch after fixing the config/recipe — no re-sync needed unless the corpus changed.
`modal volume get mailwoman-training /output-<run>/ ./output/` pulls a finished run's artifacts.
