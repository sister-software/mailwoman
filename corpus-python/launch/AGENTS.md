# Modal retrain launch — runbook

Notes for whoever (agent or human) launches a training run on Modal. Read this before touching the
`launch/` package or kicking a retrain. The flow has several non-obvious failure points; each failure mode
below has cost a run or hours.

## Run it with `-m`, from `corpus-python/`

```bash
cd corpus-python
modal run -m launch.train_remote::<name> [--flag value ...]
```

**Module mode, never a file path.** `modal run launch/train_remote.py` imports the file as a TOP-LEVEL
module with `launch/` itself on `sys.path`, so `launch` is unimportable and every `from .x import y` in
the package raises `ImportError: attempted relative import with no known parent package`. `-m` imports it
as `launch.train_remote` with the package intact.

`launch/train_remote.py` defines nothing. It imports every module so the one `app` carries every
function, because `::<name>` resolves against that file's namespace — its docstring has the table of
what lives where.

## The flow, in one line

Corpus + configs + tokenizer live in Cloudflare R2 (`mailwoman-assets`) → a **container-side `rclone`**
pulls them into the `mailwoman-training` Modal Volume (`/data`) → the training reads from the volume.
The local `.env` carries the R2 creds (`RCLONE_S3_*`); `launch/app.py` loads it itself, so `source .env`
before `modal run` is not required (but IS required for local `rclone`).

## ⚠️ `modal volume put` is BLIND — never use it for the corpus

Files written via `modal volume put` are visible to `modal volume ls/get` but **NOT to a mounted
training container**, and `vol.reload()` does not bridge it (verified 2026-06-12 with a marker file).
Everything must go through **R2 → a container-side `rclone` → `vol.commit()`**. When the bucket refuses
the token, `stage_v8cjk_regs` does the same container-side write from a local mount instead.

## Launching a retrain (the v1.6.0-boundary-stress example)

1. **Build the corpus locally** — for an overlay (base + your new slice), assemble the overlay manifest.
2. **Re-root the manifest paths to `/data`.** The data loader (`data/loader.py`) reads each slice's
   manifest `path` AS-IS; base slices must point at `/data/corpus/versioned/<base>/…` (where the base
   `sync` lands them), NOT the local `/mnt/playpen` build path. The overlay assembler does this
   (`_reroot`). **Verify: `python -c "...; sum('/mnt' in s['path'] for s in slices)"` must be 0.**
   _This bit us on v1.6.0: the manifest's 690 base slices pointed at `/mnt/playpen`, so on the volume
   the loader would re-root them under the OVERLAY dir (which holds only the new slice) and find nothing._
3. **Push the deltas to R2.** `set -a; source .env; set +a` then
   `rclone copy corpus-python/src/ :s3:mailwoman-assets/corpus-python/src/ --exclude "**/__pycache__/**"`
   (delivers the new config) and `rclone copy <overlay-dir>/ :s3:mailwoman-assets/corpus/<ver>/<corpus>/`.
   R2 intermittently returns **501** — ride it with `--low-level-retries 30 --retries 8` (each op
   succeeds on a retry). **Pass rclone flags inline, not via a shell variable** — zsh doesn't word-split
   unquoted vars, so `$FLAGS` arrives as one bogus flag.
4. **Add a row to `launch/corpora.py`**, not a function. A row names its transfers with `corpus()`,
   `mirror()` and `file_into()`, the `__pycache__` directories to clear, and the paths that must exist
   afterwards — the config, the MANIFEST, your slice, AND a re-rooted base slice. The base + tokenizer
   usually persist on the volume from prior runs, so don't re-transfer the ~30 GB base unless it is
   actually missing. When a path list cannot say what you need — a numbered range, a file's contents —
   put that in the country's own `staging.py` and name it in the row's `verifier`.

   While a corpus is still being tried, `sync_assets --corpus-versions <name>` stages it with no row at
   all. Add the row when it becomes a run somebody will repeat.

5. **Run the sync:** `modal run -m launch.train_remote::sync --version <key>`. It raises naming anything
   that did not land, so a clean exit is the confirmation.
6. **Tokenizer:** confirm the recipe's `tokenizer_dir` already exists on the volume (`modal volume ls
mailwoman-training models/tokenizer`). Re-using the base run's tokenizer keeps it OUT of the variable
   set; a new tokenizer is a separate, intended change.
7. **Launch the GPU train (the real spend).** Through the detached launcher, never from a shell: a
   `modal run` is a local client whose death cancels the remote input, so a harness that kills the
   client loses the run. The Bash guard refuses the direct spelling for that reason.

   ```bash
   node packages/mailwoman/lib/dev-tools/launch-detached.run.ts \
     --log <file> --cwd corpus-python \
     -- modal run -d -m launch.train_remote --config <recipe>.yaml --resume none
   ```

8. **Sanity-check the loss in the first ~300 steps — BEFORE walking away.** `modal app logs <app-id>`;
   `train_loss` must be a normal CE scale (O(1–10)) and **decreasing**. An exploded loss (thousands /
   millions, not falling) means a loss term is `-inf`-ing gold labels. _This bit v1.6.0: the conventions
   loss-mask (rider) forbids FR `street_prefix`, which the boundary slice's fr-prefix shape TEACHES → loss
   ~7M. Killed at step 2000, disabled the mask, relaunched (loss 5.0→1.6)._ Don't bundle a per-locale
   label/transition mask with a slice that teaches a label that locale's convention forbids — reconcile
   the convention table with the actual training labels first.
9. **Watch the check:** the recipe's pre-registered check is canonical — targets move up, non-regression
   floors hold. A below-bar number is a MISS to confront (re-baseline with a stated reason, or iterate),
   never a quiet pass. Restating a bar from memory drifts it.

## Stale `__pycache__`

A container-side write of new `.py` over old leaves stale `.pyc` that imports instead (the night-3 pyc
failure mode). Every `sync_*` clears `…/mailwoman_train/__pycache__` before `vol.commit()`.

## Recovering

The Volume persists across runs (outputs under `/data/output*`). A failed train doesn't corrupt the
synced corpus, so re-launch after fixing the config/recipe — no re-sync needed unless the corpus changed.
`modal volume get mailwoman-training /output-<run>/ ./output/` pulls a finished run's artifacts.

## After the run: the promote/no-promote check (v1.6.0-boundary-stress example)

The training function writes ONLY checkpoints + `train_log.csv` to the output dir — **no `model.onnx`,
`model-card.json`, or `crf-transitions.json`.** You produce the evaluatable artifact yourself. Two
simplifiers for this model: (1) the STAGE3 label set is stable, so the existing
`neural-weights-en-us/model-card.json` (labels-identical) is reused as-is — no packaging step for the
eval. (2) `crf_loss_weight` is `0.0`, so `export_crf_transitions()` returns `None` and the bundle ships
no `crf-transitions.json`; production therefore decodes **argmax**, and a check run without it is faithful.

```bash
# (from corpus-python/)
# 1. Export the final checkpoint to fp32 ONNX (writes {output-dir}/model.onnx on the volume)
modal run -m launch.train_remote::export_onnx \
  --output-dir=/data/output-v160-boundary-stress-s42 --step=40000

# 2. Int8-quantize it (must run in the training image; local ORT trips on the dynamo graph)
modal run -m launch.train_remote::quantize_onnx \
  --fp32-path=/data/output-v160-boundary-stress-s42/model.onnx \
  --int8-path=/data/models/quantized/model-v160-step-40000-int8.onnx

# 3. Fetch the int8 artifact (the ship format — grade what production runs)
mkdir -p ./out/v160
modal volume get mailwoman-training /models/quantized/model-v160-step-40000-int8.onnx ./out/v160/model.onnx

TOK=/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model

# 4a. The 4-shape TARGET check (the headline — street_suffix/comma-less/fr-prefix/hn-after)
node packages/mailwoman/lib/dev-tools/boundary-stress-eval.run.ts \
  --model ./out/v160/model.onnx --tokenizer "$TOK" \
  --model-card neural-weights-en-us/model-card.json --n 300

# 4b. The per-locale FLOORS check (guardrail non-regression). score-affix.ts hardcodes the repo card +
#     tokenizer — both already correct for v1.6.0 (labels identical, same v0.6.0-a0 tokenizer).
node packages/mailwoman/out/cli/index.js eval check \
  --model ./out/v160/model.onnx --int8 ./out/v160/model.onnx \
  --spec mailwoman/eval-harness/specs/v1.6.0-boundary-stress.json \
  --tokenizer "$TOK" --card neural-weights-en-us/model-card.json \
  --gazetteer-lexicon data/gazetteer/anchor-lexicon-v1.json \
  --out-dir /tmp/check-v160
cat /tmp/check-v160/verdict.json
```

Both must pass to ship: 4a moves the four boundary targets up; 4b holds the guardrail floors. The floors
spec (`mailwoman/eval-harness/specs/v1.6.0-boundary-stress.json`) carries a stated `us.street` caveat — the recipe's
80.4 is the pre-#492 shipped value; recent models sit at ~76-78, so it's floored at the committed 74.0
pending a re-anchor to v1.5.1's measured number.
