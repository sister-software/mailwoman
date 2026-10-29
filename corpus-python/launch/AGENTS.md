# Modal retrain launch — runbook

Notes for whoever (agent or human) launches a training run on Modal. Read this before touching the
`launch/` package or kicking a retrain. The flow has several non-obvious failure points. Each failure mode
below has cost a run or hours.

## Run it with `-m`, from `corpus-python/`

```bash
cd corpus-python
uv run --extra dev modal run -m launch.train_remote::<name> [--flag value ...]
```

**Through the venv, never a global `modal`.** A function's local entrypoint imports `mailwoman_train`, which
only the corpus-python venv holds, and the global `modal` binary cannot see that venv. The `dev` extra pins
the Modal client (`modal==1.4.3` in the root `pyproject.toml`), so `uv run --extra dev modal …` runs the
pinned client with `mailwoman_train` importable. The `modal volume` and `modal app` commands below read only
the volume and the app, so the global binary runs them as well.

**A change under `corpus-python/src` reaches a run only after `mailwoman corpus upload --code` and
`sync_assets --code`,** because containers import `mailwoman_train` from the volume and mount only `launch/`
locally.

**A crate change reaches a run only through an image rebuild.** The training loader encodes rows through the
`mailwoman_mtf` extension, which `training_image` builds from `packages/mtf` with the pinned Rust toolchain and
maturin. Modal rebuilds the image when a file under `packages/mtf` changes, which takes a few minutes on the next
launch. `corpus upload --code` carries `corpus-python/src` only, so it never carries a crate change.
`loader_profile` measures the loader's host-side cost per batch in a CPU container from this checkout's source.

**Module mode, never a file path.** `modal run launch/train_remote.py` imports the file as a TOP-LEVEL
module with `launch/` itself on `sys.path`, so `launch` is unimportable and every `from .x import y` in
the package raises `ImportError: attempted relative import with no known parent package`. `-m` imports it
as `launch.train_remote` with the package intact.

`launch/train_remote.py` defines no function of its own. It imports every module so the one `app`
registers every function, because `::<name>` resolves against that file's namespace. The file's docstring has
the table of what lives where.

## The flow, in one line

Corpus + configs + tokenizer live in Cloudflare R2 (`mailwoman-assets`) → a **container-side `rclone`**
pulls them into the `mailwoman-training` Modal Volume (`/data`) → the training reads from the volume.

## Settings and credentials

`launch/settings.py` is the one place the launcher reads configuration. It reads `.env` the way
`packages/core/lib/env/env-file.ts` does (the working directory's file, else the main checkout's), lets the
process environment override it, and gives each value one documented default:

| Variable                                                  | Default              | Meaning                                              |
| --------------------------------------------------------- | -------------------- | ---------------------------------------------------- |
| `MAILWOMAN_MODAL_APP`                                     | `mailwoman-training` | the Modal app                                        |
| `MAILWOMAN_MODAL_VOLUME`                                  | `mailwoman-training` | the training volume                                  |
| `MAILWOMAN_VOLUME_MOUNT`                                  | `/data`              | the volume's mount in a container                    |
| `MAILWOMAN_R2_BUCKET`                                     | `mailwoman-assets`   | the R2 bucket                                        |
| `MAILWOMAN_MODAL_TRAIN_GPU`                               | `A100-80GB`          | the training GPU; `--gpu` overrides it per launch    |
| `MAILWOMAN_MODAL_GRADE_GPU` / `MAILWOMAN_MODAL_EVAL_GPU`  | `A100` / `A10G`      | the grading functions' GPUs                          |
| `MAILWOMAN_MODAL_TRAIN_RETRIES`                           | `3`                  | retries after a failed or preempted training attempt |
| `MAILWOMAN_MODAL_R2_SECRET` / `MAILWOMAN_MODAL_HF_SECRET` | unset                | named Modal secrets                                  |

The non-secret values are baked into the image with `Image.env`, so a container reads what the local
process read. `mailwoman_train/env.py` reads `MAILWOMAN_VOLUME_MOUNT` and `MAILWOMAN_SHA256_CACHE` from
that environment.

**Credentials come from a named Modal secret.** Create it once from `.env`. This is an operator step,
because a secret is a cloud resource:

```bash
set -a; source .env; set +a
modal secret create mailwoman-r2 \
  RCLONE_S3_PROVIDER="$RCLONE_S3_PROVIDER" RCLONE_S3_ACCESS_KEY_ID="$RCLONE_S3_ACCESS_KEY_ID" \
  RCLONE_S3_SECRET_ACCESS_KEY="$RCLONE_S3_SECRET_ACCESS_KEY" RCLONE_S3_ENDPOINT="$RCLONE_S3_ENDPOINT" \
  RCLONE_S3_REGION="$RCLONE_S3_REGION" RCLONE_S3_NO_CHECK_BUCKET=true
modal secret create mailwoman-hf HF_TOKEN="$HF_TOKEN"
```

then add `MAILWOMAN_MODAL_R2_SECRET=mailwoman-r2` and `MAILWOMAN_MODAL_HF_SECRET=mailwoman-hf` to `.env`.
Until then the fallback copies the `RCLONE_S3_*` keys from `.env` into an ephemeral secret, as before.
Neither path raises at import, so `versions`, `debug_volume`, `run_tests` and `export_onnx` run without
R2 credentials; `sync`, `sync_assets` and the R2 pushes raise at their start naming the missing keys.

Every rclone transfer passes `--s3-no-check-bucket`. R2 answers the bucket check with `NotImplemented`,
and `.env`'s `RCLONE_S3_NO_CHECK_BUCKET` reaches only a shell that sourced it.

## ⚠️ `modal volume put` is BLIND — never use it for the corpus

Files written via `modal volume put` are visible to `modal volume ls/get` but **NOT to a mounted
training container**, and `vol.reload()` does not bridge it (verified 2026-06-12 with a marker file).
Everything must go through **R2 → a container-side `rclone` → `vol.commit()`**. When the bucket refuses
the token, `stage_v8cjk_regs` does the same container-side write from a local mount instead.

## Launch a retrain (the v1.6.0-boundary-stress example)

1. **Build the corpus locally** — for an overlay (base + your new recipe output), assemble the overlay manifest.
2. **Re-root the manifest paths to `/data`.** The data loader (`data/loader/`) reads each parquet file's
   manifest `path` unchanged. Base parquet files must point at `/data/corpus/versioned/<base>/…` (where the base
   `sync` lands them) rather than the local `$MAILWOMAN_DATA_ROOT` build path. The overlay assembler does this
   (`_reroot`). **Verify: `python -c "...; sum('/mnt' in s['path'] for s in manifest_files(data))"` must be 0.**
   _This bit us on v1.6.0: the manifest's 690 base parquet files pointed at `$MAILWOMAN_DATA_ROOT`, so on the volume
   the loader would re-root them under the overlay dir (which holds only the new recipe output) and find no base file._
3. **Push the deltas to R2 with the uploader:**
   `node packages/mailwoman/out/cli/main.js corpus upload --corpus-directory <entry> --code`. It is the one
   writer. For a nested local entry (`<entry>/corpus-<entry>/`) it sends the inner directory to
   `corpus/<entry>/`, the `WRAPPED` layout. `sync_assets` reads the layout back from the bucket listing:
   `corpus/<entry>/corpus-<entry>/` is `NESTED`, anything else `WRAPPED`, and both land at
   `/data/corpus/versioned/<entry>/corpus-<entry>/`. A flat local entry needs `sync_assets --layout flat`,
   because the bucket cannot tell it from `WRAPPED`. When a hand-run `rclone` is unavoidable, pass
   `--s3-no-head --s3-no-check-bucket --low-level-retries 30 --retries 8` inline (zsh does not word-split
   an unquoted `$FLAGS`).
4. **Add a row to `launch/corpora.py`** rather than a function. A row names its transfers with `corpus()`,
   `mirror()` and `file_into()`, the `__pycache__` directories to clear, and the paths that must exist
   afterwards — the config, the MANIFEST, your recipe output, and a re-rooted base parquet file. The base + tokenizer
   persist on the volume from prior runs in most cases, so don't re-transfer the ~30 GB base unless the
   volume lacks it. When a path list cannot express what you need — a numbered range, a file's contents —
   put that in the country's own `staging.py` and name it in the row's `verifier`.

   While a corpus is still being tried, `sync_assets --corpus-versions <name>` stages it with no row at
   all. Add the row when it becomes a run somebody will repeat.

5. **Run the sync:** `uv run --extra dev modal run -m launch.train_remote::sync --version <key>`. It raises naming anything
   that did not land, so a clean exit is the confirmation.
6. **Tokenizer:** confirm the recipe's `tokenizer_dir` already exists on the volume (`modal volume ls
   mailwoman-training models/tokenizer`). Re-using the base run's tokenizer keeps it out of the variable
   set. A new tokenizer is a separate, intended change.
7. **Launch the GPU train (the real spend).**

   ```bash
   node packages/mailwoman/tools/dev-tools/launch-detached.run.ts \
     --log <file> --cwd corpus-python \
     -- uv run --extra dev modal run -d -m launch.train_remote --config <recipe>.yaml --fresh
   ```

   The entry point runs `preflight` on CPU and waits for it. The preflight hashes every corpus file
   into the volume sidecar `/data/audits/sha256-cache.json` (keyed by path, size and mtime, so a later
   process rehashes only a changed file), runs the corpus-receipt, validation-coverage and label-support
   audits the config declares, checks the wall-clock budget, and writes
   `/data/audits/preflight-<key>.json`. The key digests the config's sha256 and the MANIFEST's file sha256
   set. The GPU function verifies that receipt and refuses to start without it.

   The entry point then **spawns** the GPU function and prints `function_call_id=fc-…` and a dashboard
   link. A spawned call does not depend on the client, but the app must be detached (`-d`): without it the
   app stops when the entry point returns. Read the call later with
   `uv run --extra dev python -m launch.call_status fc-… [--wait <s>]`, which starts no container.

   The detached launcher stays, for the preflight: that phase is a blocking `.remote()` that Modal
   cancels when the client dies, and on a cold sha256 cache it hashes the whole corpus. The Bash guard
   still refuses the direct spelling.

   **Resume is automatic.** The GPU function runs under `modal.Retries` (`MAILWOMAN_MODAL_TRAIN_RETRIES`,
   default 3) with `single_use_containers=True`, and every attempt resumes from the newest complete
   `step-*` checkpoint in the run's output directory (`launch/resume.py`). `--fresh` clears that directory
   once, in the preflight, before anything is spawned. No attempt deletes anything. `--branch-from
   <checkpoint>` names a start point used only while the output directory holds no checkpoint. The old
   `--resume` flag is gone. `--resume none` is now `--fresh`, `--resume auto` is the default, and the
   recipe headers use the new spellings.

   **We run `modal run -d` rather than a deployed app.** A deployment would let any shell spawn training
   by name (`modal.Function.from_name`), but it adds an operator `modal deploy` after every `launch/`
   change, and a stale deployment would run old launcher code against a new config. The training code
   that changes most already travels on the volume, so a deployment would save only the few seconds
   an ephemeral app takes to register its functions. Revisit if launches need to start from somewhere without this checkout.

   **GPU sizing.** `--gpu <type>` (or `MAILWOMAN_MODAL_TRAIN_GPU`) picks the card. The default stays
   `A100-80GB`. The probe model is small (384 hidden, 6 layers, batch 128) and likely fits a cheaper card,
   but the wall-clock preflight reads an observed rate per GPU type from `OBSERVED_SECONDS_PER_100_STEPS` in
   `launch/wall_clock.py` and refuses a GPU that has none. Measure a candidate card with a 2,000-step probe,
   read the median seconds per 100 steps from its `train_log.csv`, and add the row before changing the default.

8. **Sanity-check the loss in the first ~300 steps — BEFORE walking away.** `modal app logs <app-id>`;
   `train_loss` must be a normal CE scale (O(1–10)) and **decreasing**. An exploded loss (thousands /
   millions rather than falling) means a loss term is `-inf`-ing gold labels. _This bit v1.6.0: the conventions
   loss-mask (rider) forbids FR `street_prefix`, which the boundary recipe's fr-prefix shape TEACHES → loss
   ~7M. Killed at step 2000, disabled the mask, relaunched (loss 5.0→1.6)._ Don't bundle a per-locale
   label/transition mask with a recipe that teaches a label that locale's convention forbids — reconcile
   the convention table with the actual training labels first.

   `modal app logs` is a best-effort tail. It stalls after `Heartbeat attempt failed` lines while the
   training continues, so a silent log is no evidence of progress. Read a run's progress from the
   volume: `modal volume ls mailwoman-training output-<run>/` lists the latest `step-<N>` checkpoint,
   and the `[eval]` lines of `train_log.csv` on the volume carry the eval trajectory.

9. **Watch the check:** the recipe's pre-registered check is canonical — targets move up, non-regression
   floors hold. A below-bar number is a MISS to confront (re-baseline with a stated reason, or iterate),
   never a quiet pass. A bar restated from memory drifts.

## Standalone audits run on the host

The preflight still runs the corpus-receipt, validation-coverage and label-support audits inside its CPU
container. To audit a corpus without launching, run the TypeScript audits on a host that mirrors the
volume at `$MAILWOMAN_DATA_ROOT`. They write the reports the Python audits wrote, byte for byte, and read
the corpus through the `mtf-node` addon, which Cargo builds on first use:

```bash
node packages/mailwoman/tools/training/audits/epoch-mixture.run.ts --config <yaml> --json <path>
node packages/mailwoman/tools/training/audits/validation-coverage.run.ts <yaml> --json <path>
node packages/mailwoman/tools/training/audits/label-support.run.ts <yaml> --json <path>
node packages/mailwoman/tools/training/audits/opening-token.run.ts <yaml> --json <path>
node packages/mailwoman/tools/training/audits/region-code-token.run.ts <yaml> --json <path>
node packages/mailwoman/tools/training/audits/comma-segment-number.run.ts <yaml> --json <path>
node packages/mailwoman/tools/training/audits/suffix-feed.run.ts --config <yaml> \
  --classify-lexicon <v2 lexicon> --relabel-lexicon <lexicon> --json <path>
```

A config states its paths under `/data`. Pass `--corpus-dir` with the host copy, where the tool takes one,
or audit a copy of the config with its paths re-rooted.

## A config derived from a control

When a training config is derived from a control's config, load both with `load_config` and assert
that the parsed key sets match, naming any key that is present in only one. A text pattern over
the YAML misses a quoted key: YAML 1.1 resolves bare `NO` to `false`, so Norway's `country_weights`
entry is written `"NO": 1.0`, and a regex over unquoted keys drops it. `ConfigSchema` refuses the
unquoted spelling. The omission is visible only from the parse.

## Trackio

Trackio (`src/mailwoman_train/observability/trackio.py`) logs training progress to the private HF
Space `sister-software/mailwoman-trackio`. It is off by default and a no-op when disabled. The
durable store is the HF bucket `sister-software/mailwoman-trackio-bucket` at `trackio/mailwoman.db`
rather than an HF dataset. The Space's `TRACKIO_DIR` is ephemeral and is restored from the bucket on
boot, so a legend that lists runs beside empty charts means a stale running Space: restart it with
`POST /api/spaces/<id>/restart`, and the metrics survive in the bucket. The Space needs an `HF_TOKEN`
secret with bucket read-write access.

Inspect the store directly with
`hf buckets cp hf://buckets/sister-software/mailwoman-trackio-bucket/trackio/mailwoman.db <local>`
and read the sqlite `metrics` and `configs` tables, keyed by `run_name` and `step`. The run name is
derived from `output_dir` and `resume` is `"allow"`, so a restarted run continues the same dashboard
run.

## Stale `__pycache__`

A container-side write of new `.py` over old leaves stale `.pyc` that imports instead, so the run
imports the PREVIOUS code and reports success against it. Every sync clears the directories its row's
`pycache` names before `vol.commit()`; the default is `…/mailwoman_train/__pycache__`, and a row that
also ships configs uses `PACKAGE_AND_CONFIGS`.

## Recovery

The Volume persists across runs (outputs under `/data/output*`). A failed train doesn't corrupt the
synced corpus, so re-launch after fixing the config/recipe — no re-sync needed unless the corpus changed.
`modal volume get mailwoman-training /output-<run>/ ./output/` pulls a finished run's artifacts. The path
is the config's `output_dir` without the `/data` mount. A run that died past its retries continues from
its last save on a relaunch without `--fresh`.

The local-mount fallback `stage_v8cjk_regs` mounts local corpora only under
`MAILWOMAN_STAGE_LOCAL_CORPORA=1`. Every other `modal run` uploads none of them.

## After the run: the promote/no-promote check (v1.6.0-boundary-stress example)

The training function writes only checkpoints + `train_log.csv` to the output dir — **no `model.onnx`,
`model-card.json`, or `crf-transitions.json`.** You produce the evaluatable artifact yourself. Two
simplifiers for this model: (1) the STAGE3 label set is stable, so the existing
`neural-weights-en-us/model-card.json` (labels-identical) is reused as-is — no packaging step for the
eval. (2) `crf_loss_weight` is `0.0`, so `export_crf_transitions()` returns `None` and the bundle ships
no `crf-transitions.json`; production therefore decodes **argmax**, and a check run without it is faithful.

```bash
# (from corpus-python/)
# 1. Export the final checkpoint to fp32 ONNX (writes {output-dir}/model.onnx on the volume)
uv run --extra dev modal run -m launch.train_remote::export_onnx \
  --output-dir=/data/output-v160-boundary-stress-s42 --step=40000

# 2. Int8-quantize it (must run in the training image; local ORT trips on the dynamo graph)
uv run --extra dev modal run -m launch.train_remote::quantize_onnx \
  --fp32-path=/data/output-v160-boundary-stress-s42/model.onnx \
  --int8-path=/data/models/quantized/model-v160-step-40000-int8.onnx

# 3. Fetch the int8 artifact (the ship format — grade what production runs)
mkdir -p ./out/v160
modal volume get mailwoman-training /models/quantized/model-v160-step-40000-int8.onnx ./out/v160/model.onnx

TOK=$MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model

# 4a. The 4-shape TARGET check (the headline — street_suffix/comma-less/fr-prefix/hn-after)
node packages/mailwoman/tools/dev-tools/boundary-stress-eval.run.ts \
  --model ./out/v160/model.onnx --tokenizer "$TOK" \
  --model-card neural-weights-en-us/model-card.json --n 300

# 4b. The per-locale FLOORS check (guardrail non-regression). score-affix.ts hardcodes the repo card +
#     tokenizer — both already correct for v1.6.0 (labels identical, same v0.6.0-a0 tokenizer).
node packages/mailwoman/out/cli/main.js eval check \
  --model ./out/v160/model.onnx --int8 ./out/v160/model.onnx \
  --spec mailwoman/eval-harness/specs/v1.6.0-boundary-stress.json \
  --tokenizer "$TOK" --card neural-weights-en-us/model-card.json \
  --gazetteer-lexicon data/gazetteer/anchor-lexicon-v1.json \
  --out-dir /tmp/check-v160
cat /tmp/check-v160/verdict.json
```

Both must pass to ship: 4a moves the four boundary targets up, and 4b holds the guardrail floors. The floors
spec (`mailwoman/eval-harness/specs/v1.6.0-boundary-stress.json`) states a `us.street` caveat. The recipe's
80.4 is the pre-#492 shipped value. Recent models sit at ~76-78, so it's floored at the committed 74.0
pending a re-anchor to v1.5.1's measured number.
