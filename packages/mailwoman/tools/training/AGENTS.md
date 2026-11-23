# AGENTS.md — training tools

Read the repository-root `AGENTS.md` and `packages/mailwoman/AGENTS.md` first. This file covers launching the Rust
trainer on Modal and the host audits a launch requires.

## Launch on Modal

`launch/launch.run.ts` runs `trainer train` in a Modal sandbox. It needs no Python and starts no Modal Function.

```sh
node packages/mailwoman/tools/training/launch/launch.run.ts start --config <yaml> --fresh [--device <Modal GPU>]
node packages/mailwoman/tools/training/launch/launch.run.ts status <run key>
node packages/mailwoman/tools/training/launch/launch.run.ts logs <run key> [--lines 200]
node packages/mailwoman/tools/training/launch/launch.run.ts cancel <run key>
node packages/mailwoman/tools/training/launch/launch.run.ts restart <run key>
```

`start` does these steps on the host, in order, before anything is billed:

1. It resolves the config with `buildResolvedTrainingConfig`, which is also the source-rights admission.
2. It refuses a second launch while a sandbox tagged with the same run key is running. The run key is the first 16 hex
   digits of the sha256 of the run's checkpoint directory.
3. It runs the preflight (`launch/preflight.ts`) against the copy of the volume under `MAILWOMAN_DATA_ROOT`. The
   preflight runs each audit the config declares (`required_corpus_receipts`, `required_validation_coverage`,
   `required_validation_label_support`, `prominent_place_coverage`) on a copy of the config re-rooted at the host copy, checks the wall clock
   (`launch/wall-clock.ts`), and writes the receipt under `<data root>/audits`.
4. It publishes or reuses the trainer image (`launch/image.ts`) and starts one detached sandbox, then records the run
   under `<data root>/launch/runs/<run key>.json`.

**The host copy must be the volume's corpus.** The receipt binds the YAML and the MANIFEST's file sha256 set read on
the host. The sandbox hashes the volume's `MANIFEST.json` and refuses when its bytes differ from the host's, so a corpus
staged on the volume but not mirrored on the host, or the reverse, starts no training.

`--dry-run` runs every host step, prints the image and sandbox it would start, and makes no Modal call.

### Inside the sandbox

The sandbox runs the supervisor (`launch/supervisor.ts`), a bash script:

1. It waits up to 300 s for the host to write the YAML, the resolved JSON and a `ready` marker into the container,
   copies the two under `<mount>/launch/<YAML sha256 prefix>/`, and refuses a resolved config that describes another
   YAML. The inputs travel as files because a sandbox's environment is a Modal secret. A Modal secret holds at most 32 KiB per
   value.
2. It checks the device with `trainer device` and refuses another one. Under `--fresh` it then clears the output
   directory once.
3. It runs `trainer train <resolved.json> --resume <auto | branch>` and commits the volume (`sync <mount>`) after every
   `[save] checkpoint` line.
4. It restarts the trainer after a failed exit, up to `--retries` (default `MAILWOMAN_MODAL_TRAIN_RETRIES`, 3), in
   the same container. Each attempt resumes with `--resume auto` once the output directory holds a complete
   checkpoint, and a `--branch-from` run resumes from its branch checkpoint until then.

The sandbox exits 0 when training completes and 3 on a refusal. `status` reads that code: `completed`, `refused`,
`running`, or `stopped` for any other exit. That covers a spent retry count, the timeout and a preemption. `restart`
starts a fresh sandbox for a stopped run. The new sandbox resumes from the newest complete checkpoint and keeps every file the run wrote.
`cancel` terminates the running sandbox, and the checkpoints it committed stay. `start`, `restart` and `cancel` each
hold the run's host lock, so a cancel refuses while a start or restart of the run is recording a sandbox.

### The trainer image

The JavaScript SDK copies no local files into an image. A build sandbox on the base layers (libtorch at its pinned
sha256, the CUDA wheels for the CUDA image, the Rust toolchain the root `rust-toolchain.toml` pins) receives a
tarball of the trainer sources on stdin, builds `trainer-cli`, and refuses a binary whose shared objects do not resolve.
Its filesystem snapshot is published as `mailwoman-trainer-<variant>-<toolchain>-<source digest>`, so a later launch
with the same sources reuses it. A change under `packages/trainer` or the mtf crates builds a new image on the next
launch.

### Commercial training

`start --commercial` trains under a commercial training grant instead of the AGPL. Sister Software's own runs use the
grant `mtg_88553b5da439d4f8dc6c584a`, issued to Nirrius LLC, d/b/a Sister Software under
`commercial-training-2026-11`, permitting `train` and `deploy`, and expiring 2027-02-22. Two Modal secrets back a
commercial launch, and the launcher reads their names from two variables:

| Variable                            | Secret                     | Holds                                                                                      |
| ----------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------ |
| `MAILWOMAN_MODAL_TRAINING_SECRET`   | `mailwoman-training-grant` | `MAILWOMAN_TRAINING_GRANT`, the `mwt1` grant                                               |
| `MAILWOMAN_MODAL_PROVENANCE_SECRET` | `mailwoman-provenance`     | `MAILWOMAN_PROVENANCE_SIGNING_KEY` and `MAILWOMAN_PROVENANCE_SIGNING_KID` (`p11-75b09012`) |

```sh
node --env-file=.env packages/mailwoman/tools/training/launch/launch.run.ts start --config <yaml> --fresh --commercial
```

A commercial launch refuses before its preflight when either variable is unset. It builds the trainer with
`trainer-cli`'s `commercial` feature into its own image (`mailwoman-trainer-commercial-<variant>-…`), which also holds
`trainer-export`. It attaches both secrets on every start and restart. The launch record keeps the secrets' names, and
no record, argument, log or artifact holds the token or the key. A grant also set in the host's
`MAILWOMAN_TRAINING_GRANT` is verified before the preflight.

In the sandbox the supervisor runs `trainer authorize` after the device check and before `--fresh` clears anything. An
authorization refusal there, or an exit 3 from `trainer train` on a retry, refuses the run without a retry and leaves
its checkpoints as committed. `restart` restarts a refused commercial run once the grant in the secret is renewed. Each
run writes `TRAINING.json` beside its checkpoints.

When training completes, the supervisor exports the newest complete checkpoint with `trainer-export export-onnx` and
`quantize` into `<run base>/export/`. The export passes the char window `data.max_unit_width` for a
`use_char_embed` model. Each graph leaves with a `<graph>.provenance.json` that the provenance key signs as `managed`,
and the supervisor commits the volume. A failed export stops the sandbox with the exporter's exit code, and `restart`
finds the run complete and exports again. `fetch <run key>` copies `export/` with the rest of the run.

To renew the grant before 2027-02-22, run `mailwoman license grant-training --holder "Nirrius LLC, d/b/a Sister Software"
--grant mtg_88553b5da439d4f8dc6c584a --expires <date within 92 days>`. Then replace the secret:
`modal secret create mailwoman-training-grant --from-json <file> --force`, where the file holds
`{"MAILWOMAN_TRAINING_GRANT": "<token>"}`. `docs/engineering/reference/product-license-tokens.mdx` specifies the grant,
the record and the manifest, and lists the keys in service. Without `--commercial` the launch runs the open-source
trainer, which checks no grant, leaves export to the host, and records `AGPL-3.0-only`.

### The lifecycle checks

`--cpu` runs the CPU image at 4 CPUs. `--fail-at-step <n>`, accepted only with `--cpu`, kills the trainer once after it
logs step `n`; the supervisor's retry then resumes it. `--timeout-seconds` and `--retries` override the defaults for one
launch. `launch/*.test.ts` checks each lifecycle step against a stub boundary and the supervisor against a fake
`trainer`.

## Settings

`launch/settings.ts` reads `MAILWOMAN_MODAL_APP`, `MAILWOMAN_MODAL_VOLUME`, `MAILWOMAN_MODAL_TRAIN_GPU`,
`MAILWOMAN_MODAL_TRAIN_RETRIES` and `MAILWOMAN_MODAL_R2_SECRET` with the Python launcher's defaults, and
`MAILWOMAN_MODAL_TRAINING_SECRET` and `MAILWOMAN_TRAINING_GRANT` for a commercial launch, over the corpus
package's view. That view holds `MAILWOMAN_DATA_ROOT` and `MAILWOMAN_VOLUME_MOUNT`. Modal credentials come from
`MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` or `~/.modal.toml`.

The default GPU is the A100-40GB. On the 29.6 M-parameter model at batch 128 in bf16, the Rust trainer ran 15.46
steps/s on it, 9.95 on an A10 and 6.96 on an L4, in sandboxes of 8 CPUs and 32 GiB. The A100-80GB costs $0.40 per
hour more for memory this model doesn't use. `launch/wall-clock.ts` records each rate.

Modal billed a GPU training sandbox's CPU and memory on the request: $0.142 per requested CPU-hour and $0.024 per
GiB-hour on 2026-10-31, three times the per-core and per-GiB rates on Modal's pricing page. An hour of #2884's
8-CPU, 32 GiB run billed $1.14 of CPU and $0.77 of memory beside $2.10 of A100-40GB, and an hour of #2887's 4-CPU,
16 GiB run billed exactly half that. At 8 CPUs and 32 GiB the A100-40GB costs $0.072 per 1,000 steps and the A10
$0.084. A GPU sandbox requests 4 CPUs and 16 GiB: the trainer's resident peak was 7.29 GiB over #2887's
90,000-step run, and its trainer runs with `--threads 4` unless the launch passes another `--threads` value.

## Building the trainer on the host

`node packages/mailwoman/tools/training/libtorch.run.ts` installs the libtorch archive `launch/image.ts` pins into the
git-ignored `.cache/libtorch`, after checking its sha256. The root `.cargo/config.toml` points `LIBTORCH` there, and the
trainer crates' build scripts give their binaries and tests an rpath to its `lib/`, so `cargo test -p trainer-loop` runs
with no variable set. CI downloads the same archive in its `rust` job and sets `LIBTORCH` itself.

## Host audits

The audits under `audits/` read the corpus through the `mtf-node` addon on a host that mirrors the volume at
`MAILWOMAN_DATA_ROOT`. Each writes the report the preflight records:

```sh
node packages/mailwoman/tools/training/audits/epoch/mixture.run.ts --config <yaml> --json <path>
node packages/mailwoman/tools/training/audits/validation/coverage.run.ts <yaml> --json <path>
node packages/mailwoman/tools/training/audits/label/support.run.ts <yaml> --json <path>
node packages/mailwoman/tools/training/audits/prominent/coverage.run.ts <yaml> --json <path>
```

The prominent-place coverage receipt (#3156) reads the places table that
`tools/dev-tools/corpus/prominent/places.run.ts places` writes for one candidate database, named by
`data.prominent_place_coverage`, and scans the corpus's short admin train rows itself, in about two minutes. It
fails when a required prominent place has no drawable train row in a required shape, when a country's decile 1
holds less than half its population share of a shape's expected epoch draws, or when a short admin row writes a
dependent locality without a locality. A cell short of its target whose decile-1 places none can be written in the
shape (no WOF region for the shape, or a GeoNames-fallback score that failed its checks) is `unwritable`: it
doesn't fail the receipt, and the report lists it with its reasons. A cell with a writable decile-1 place that
misses its target fails. The report lists every failing form, and lists under each failing cell the writable
decile-1 places that have no expected draws, required or not, because a place outside the selection counts toward the share but never
toward presence. A place the corpus holds out by design counts toward neither: every one of its groups is on the
evaluation-group list or the validation list that the corpus manifest records under `evaluation_groups`. A place
can't be required in training and frozen for grading at once. `readHeldOutByDesign` in `audits/prominent/records.ts` reads both lists, refuses one
whose sha256 isn't the manifest's, takes each listed group's WOF record, and keeps a record that has no train row in
any of its groups. That pass reads every train file's ids: 322 s over v0.8.22's 1,104 files. The report's
`held_out_by_design` gives the places and lists by country, and `not_required` counts them as
`held-out-by-design`. A held-out place has no form and no population in its demand cell, so decile 1's
population share is measured over the places training can read. `audits/required-groups.ts` reads the receipt's required places as the WOF records whose groups a
held-out freeze and the validation quota skip. A sub-locality's pair with its parent is required as `locality` and `region` when the
places table marks it `postal_pair` (`isPostalLocalityPair` in `@mailwoman/gazetteer/tools/pipeline/pair/postal-children`),
and as `dependent_locality` and `locality` otherwise. The draws are what the config's sampler reads in one epoch. A row's
expected draws are its source's requested share of `train_rows_per_epoch` over the source's admitted rows, times
its country's admission chance, the arithmetic of `drawsPerAdmittedRow` and `countryAdmission` in
`exposure/shapes.ts`, over the train rows `exposure/train-shapes.ts` counts. A row of a source weighted at zero
has zero expected draws and covers no form. The receipt requires places only in the countries the config admits. The receipt key binds the table's
`PLACES.json`. The census's `tuples` step (`--config <yaml>`) writes the `prominent-places` recipe's input from the
same tables in the same units, against the base corpus the recipe joins: the config's weight for
`rendered-prominent-places` sets the recipe's draws, and the step solves for the row counts whose draws close each
cell.
