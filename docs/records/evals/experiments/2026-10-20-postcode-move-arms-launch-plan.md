---
title: "v8.0.0 postcode-move arms at 0, 0.05 and 0.15 — launch plan"
description: The configs, corpus assumptions, CPU audits, Modal launches, volume upload, spend and grading steps for the three from-scratch #2750 arms on corpus v0.8.0.
---

# v8.0.0 postcode-move arms at 0, 0.05 and 0.15 — launch plan

#2750 moved the postcode-order mix from corpus recipes into the training-time `postcode_move` augmentation. Three
from-scratch arms measure its copy rate before a rebuilt corpus ships. The operator authorized the CPU audit and the
three runs on 2026-10-20, at about $9 each.

## Run shape

- `kind`: from scratch, 60,000 steps, seed 42, `--resume none`, no `init_from`, no EWC.
- `why`: corpus v0.8.0 is a rebuilt base, and a fine-tune cannot introduce rows the base never saw.
- `control_run`: the shipped model, v7.10.0-gb-county seed 42 step 60000 (`release.config.json` `weights.lineage`,
  int8 md5 `5356ecba83e3774a5d9717277c051ac2`). A from-scratch arm has no placebo. The p000 arm is the
  within-corpus control for attributing a p005 or p015 effect to the copy rate.

## Configs

| arm  | file                                                                           | `augment_postcode_move_prob` | output dir                                             |
| ---- | ------------------------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------ |
| p000 | `corpus-python/src/mailwoman_train/configs/v8.0.0-postcode-move-p000-60k.yaml` | 0.0                          | `/data/output-v800-postcode-move-p000-s42/checkpoints` |
| p005 | `corpus-python/src/mailwoman_train/configs/v8.0.0-postcode-move-p005-60k.yaml` | 0.05                         | `/data/output-v800-postcode-move-p005-s42/checkpoints` |
| p015 | `corpus-python/src/mailwoman_train/configs/v8.0.0-postcode-move-p015-60k.yaml` | 0.15                         | `/data/output-v800-postcode-move-p015-s42/checkpoints` |

Each config is `v7.10.0-gb-county-60k.yaml` with `data.corpus_dir`, seven added receipts, the output directory and the
Trackio run name changed, and, for p005 and p015, the copy rate. Loaded through `load_config` and
`load_training_config` on 2026-10-20 (observed):

- the parsed key sets equal the control's in every arm;
- the differing keys are `data.corpus_dir`, `data.required_corpus_receipts`, `train.output_dir`,
  `train.trackio_run_name`, plus `data.augment_postcode_move_prob` in p005 and p015;
- `country_weights` holds the control's 215 keys, and `get` returns 1.0 for US, GB, FR, DE, NO, AU, NL, CZ, ES, IT,
  NZ, IN, BR and MX;
- every one of the 176 sources in `packages/corpus/data/training-manifests/v0.7.10-gb-county.json` has a weight or a
  rep, and `source_weights` and `source_reps` equal the control's;
- source rights: shippable, 168 admitted sources checked.

## Corpus

Assumed corpus path on the volume: `/data/corpus/versioned/v0.8.0/corpus-v0.8.0/MANIFEST.json`, version string
`0.8.0`. It is assembled by `mailwoman corpus overlay-manifest` from the `v0.8.0-store` base
(`/mnt/mw/corpus/versioned/v0.8.0-store`, building from `packages/corpus/data/builds/v0.7.0-de-holdout/inputs.json`)
plus the single-source overlay files that `v0.7.10-gb-county` adds to v0.7.0. Every base path is re-rooted to
`/data/corpus/versioned/v0.8.0-store/…`, and the count of manifest paths containing `/mnt` must be 0.

The base build runs the eleven adapters of v0.7.0 under their v0.7.0 source names: `ban`, `state-ia-contractors`,
`state-ny-notaries`, `state-tx-notaries`, `tiger`, `usgov-hrsa-fqhc`, `usgov-imls-pls`, `usgov-nad`, `usgov-nppes`,
`wof-admin`, `wof-postalcode`. The build is expected to keep every config source name. That is inferred from the
adapter keys, and the finished store's directory names confirm it.

## Order-pure overlays before assembly

Decided 2026-10-20: the p000 arm reads no corpus-time order mix. Four v0.7.x overlay files mixed order at corpus time:

| source                | v0.7.x file                                                                | rows (train/val/test)   | mix                                                 |
| --------------------- | -------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------- |
| `rendered-gb-os-open` | `v0.7.10-gb-county/…/rendered-gb-os-open.*.parquet`                        | 786,626 / 6,706 / 6,668 | rendered with `--intl-fraction 0.0664`              |
| `rendered-de`         | `v0.7.0-de-holdout/…/part-synth-german-00000.*.parquet`                    | 187,485 / 8,260 / 8,255 | rendered with `--intl-fraction 0.4`                 |
| `rendered-fr-order`   | `v0.7.0-de-holdout/…/part-synth-fr-order-train.train.parquet`              | 50,000 train            | includes variant C, which #2750 removed             |
| `overture`            | `v0.7.0-de-holdout/…/part-overture-multilocale-3order-train.train.parquet` | 2,400,000 train         | reversed ES, BE and PL rows from a retired producer |

In the first row group of the v0.7.10 train files (observed, 20,000 rows each), `[postcode, locality]` is contiguous in
9,970 `rendered-de` rows and `[locality, postcode]` in 15,838 `rendered-gb-os-open` rows.

1. Re-render the three recipe sources from the post-#2750 tree, at their v0.7.x counts and seeds. The recipes no
   longer take `--intl-fraction`, and `fr-order` now renders variants A, B and D:

   ```bash
   mailwoman corpus slice locale --country GB --count 800000 --seed 42 --out <dir>/rendered-gb-os-open.jsonl
   mailwoman corpus slice german --count 200000 --seed 42 --out <dir>/rendered-de.jsonl
   mailwoman corpus slice fr-order --count 50000 --seed 42 --out <dir>/rendered-fr-order.jsonl
   ```

   For each file: `mailwoman corpus align-slice`, `mailwoman dev jsonl-to-parquet`, then `mailwoman corpus split-slice`,
   which writes the `<stem>.split.<policy hash>.json` attribute file. Each keeps its wire identifier, so the configs'
   weights apply unchanged.

2. Drop the reversed `overture` rows with a deletion. Read the 3order file's `source_id`, `country`, `span_tags`,
   `span_starts` and `span_ends`. For each ES, BE and PL row, compare the postcode span's start with the locality and
   region block's against `postcodePlacement` from `@mailwoman/postcode/country-formats` (the table `postcode-layouts.json`
   is generated from). Every row whose postcode sits on the side opposite the stated placement goes into
   `<dir>/overture-reversed-es-be-pl.parquet` as a `source_id` column. No committed tool does this yet. It is a run
   tool under `packages/mailwoman/tools/dev-tools/corpus/`, and its row count per country must match the census's
   reversed counts before the deletion is used. Then `<dir>/deletions.json`:

   ```json
   [
   	{
   		"target": { "path": "train/part-overture-multilocale-3order-train.train.parquet" },
   		"sourceIDsFile": "<dir>/overture-reversed-es-be-pl.parquet",
   		"reason": "Reversed postcode order in ES, BE and PL, placed against libaddressinput's fmt. The training-time postcode move replaces it.",
   		"issue": "#2750"
   	}
   ]
   ```

3. Assemble v0.8.0 over the store, replacing the three re-rendered sources and applying the deletion:

   ```bash
   mailwoman corpus overlay-manifest --base /mnt/mw/corpus/versioned/v0.8.0-store/MANIFEST.json \
     --replace-source rendered-gb-os-open --replace-source rendered-de --replace-source rendered-fr-order \
     --deletions <dir>/deletions.json --corpus-version 0.8.0 …
   ```

   Then freeze the manifest with `freeze-overlay-manifest.run.ts` and check that the count of manifest paths containing
   `/mnt` is 0.

`invented-po-box-military` keeps its v0.7.x file. It is one of six sources the post-#2754 builder refuses for want of a
register license id, so it cannot be re-rendered yet. This config gives it reps 8.0 and the receipt
`us-military-po-box`.

## Receipts

The seven added receipts, all presence floors rather than fitted values:

| name                               | source                 | country | sequence                   | min_draws |
| ---------------------------------- | ---------------------- | ------- | -------------------------- | --------- |
| us-native-locality-region-postcode | any                    | US      | locality, region, postcode | 10,000    |
| fr-native-postcode-locality        | `ban`                  | FR      | postcode, locality         | 10,000    |
| de-native-postcode-locality        | `rendered-de`          | DE      | postcode, locality         | 1,000     |
| gb-native-locality-postcode        | `rendered-gb-os-open`  | GB      | locality, postcode         | 500       |
| au-gnaf-rows                       | `gnaf`                 | AU      |                            | 1,000     |
| fr-order-kept-variants             | `rendered-fr-order`    | FR      |                            | 1,000     |
| nl-postcode-rows                   | `rendered-nl-postcode` | NL      |                            | 1,000     |

What the audit can observe. `run_draw_pass` matches receipts on the drawn row before `emit_row`, so a receipt never
sees a moved copy. `run_emitted_pass` builds its `EmitPolicy` without reading `postcode_move_outcomes` back, and the
report holds only `emitted_level.augmented_share` across all augmentations. The loader logs
`postcode_move draws by outcome` when a stream ends, in the training log.

What can be asserted before a GPU is allocated:

1. Every receipt passes in each arm. The draw pass does not read the copy rate, so `draw_level` and
   `required_corpus_receipts` must be identical across the three reports.
2. `emitted_level.augmented_share` rises from p000 to p005 to p015. The difference is the move's copies plus the
   effect of the shifted random stream, so it checks direction only. The rate comes from step 3.
3. The moved share itself is unmeasured until the loader's outcome log of the first epoch. Read it from the p005 and
   p015 training logs and record `moved` against each skip reason. Exposing the counter in the audit report is the
   change that would make it measurable on CPU.

## Volume upload

1. `mailwoman corpus upload` the `v0.8.0-store` `store/` tree to `:s3:mailwoman-assets/corpus/v0.8.0-store/`, and the
   assembled `v0.8.0` directory (MANIFEST.json, split-attribute files, any deletions sidecars) to
   `:s3:mailwoman-assets/corpus/v0.8.0/`. Size estimate: the base part files in v0.7.10's manifest total 78.4 GB, the
   whole v0.7.0-de-holdout tree 79.1 GB, so about 75 to 80 GB for the store (unknown until the build exits). The
   overlay files total 1.1 GB and are already on the volume under their v0.7.x directories. The three re-rendered
   overlays and the deletion sidecar are new bytes, about 0.1 GB going by the v0.7.x files' sizes.
2. `rclone copy corpus-python/src/ :s3:mailwoman-assets/corpus-python/src/ --exclude "**/__pycache__/**" --low-level-retries 30 --retries 8`
   delivers the three configs.
3. From `corpus-python/`: `modal run -m launch.train_remote::sync_assets --corpus-versions v0.8.0-store,v0.8.0`,
   then confirm `modal volume ls mailwoman-training corpus/versioned/v0.8.0/corpus-v0.8.0` and that
   `models/tokenizer/v0.9.0-multisplice` exists. Add a `launch/corpora.py` row once the corpus is final.

## CPU audits

From `corpus-python/`, one per arm:

```bash
modal run -m launch.train_remote::audit_epoch_mixture --config-name v8.0.0-postcode-move-p000-60k.yaml
modal run -m launch.train_remote::audit_epoch_mixture --config-name v8.0.0-postcode-move-p005-60k.yaml
modal run -m launch.train_remote::audit_epoch_mixture --config-name v8.0.0-postcode-move-p015-60k.yaml
```

Each writes `/data/audits/epoch-mixture-<stem>.json`. A failed receipt stops the plan for a diagnosis.

## Training

```bash
node packages/mailwoman/tools/dev-tools/launch-detached.run.ts --log <log> --cwd corpus-python \
  -- modal run -d -m launch.train_remote --config v8.0.0-postcode-move-p000-60k.yaml --resume none
```

Repeat with the p005 and p015 configs. The entry point reruns the receipts on CPU as its preflight and refuses the GPU
on a failure. Check that `train_loss` falls on the CE scale in the first 300 steps of each run.

Spend: the training-arc skill gives about 4.3 hours and $9 per 60,000-step run on an A100-40GB, so $27 of the
$27 authorized for the three arms. The CPU audits run in 16 GB CPU containers and are not counted in that figure.

## Grading

For each arm: `export_onnx --step 60000`, `quantize_onnx`, fetch the int8 file, and stage a package-shaped weights
directory by dereferencing symlinks. Its md5 must differ from `5356ecba83e3774a5d9717277c051ac2`.

1. Self-control once: a staged copy of the shipped weights against itself, 0 differing rows expected.
2. `mwdev_arc candidate=<arm> control=<staged shipped> shape=from-scratch` on the full board, routed per country.
   The D-rule applies to US, GB, FR and DE: no regressed row there against shipped.
3. The held-out non-native postcode sweep, generated once from the v0.8.0 test split:

   ```bash
   node packages/mailwoman/tools/dev-tools/corpus/non-native-postcode-order-eval.run.ts \
     --corpus /mnt/mw/corpus/versioned/v0.8.0/corpus-v0.8.0 --countries US,GB,FR,DE,IT,ES,MX,BR,CA,NZ \
     --sources ban,usgov-nad,tiger,rendered-gb-os-open,rendered-de,overture --cap 500 --seed 7 \
     --out <dir>/non-native-postcode-order-v0.8.0.jsonl
   ```

   Score each arm and shipped on component exact match per country. The p000 arm against shipped measures the
   corpus change, p005 and p015 against p000 measure the copy rate. The seed pair's agreement on this set is the
   noise floor.

4. `mwdev_promotion_eval --spec v9.0.0-base` on the int8 artifact.
