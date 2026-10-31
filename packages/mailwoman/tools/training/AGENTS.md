# AGENTS.md — training tools

Read the repository-root `AGENTS.md` and `packages/mailwoman/AGENTS.md` first. This file covers launching the Rust
trainer on Modal and the host audits a launch requires.

## Launch on Modal

`launch/launch.run.ts` runs `trainer train` in a Modal sandbox. It needs no Python and starts no Modal Function.

```bash
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
   `required_validation_label_support`) on a copy of the config re-rooted at the host copy, checks the wall clock
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
`cancel` terminates the running sandbox, and the checkpoints it committed stay.

### The trainer image

The JavaScript SDK copies no local files into an image. A build sandbox on the base layers (libtorch at its pinned
sha256, the CUDA wheels for the CUDA image, the Rust toolchain the root `rust-toolchain.toml` pins) receives a
tarball of the trainer sources on stdin, builds `trainer-cli`, and refuses a binary whose shared objects do not resolve.
Its filesystem snapshot is published as `mailwoman-trainer-<variant>-<toolchain>-<source digest>`, so a later launch
with the same sources reuses it. A change under `packages/trainer` or the mtf crates builds a new image on the next
launch.

### The lifecycle checks

`--cpu` runs the CPU image at 4 CPUs. `--fail-at-step <n>`, accepted only with `--cpu`, kills the trainer once after it
logs step `n`; the supervisor's retry then resumes it. `--timeout-seconds` and `--retries` override the defaults for one
launch. `launch/*.test.ts` checks each lifecycle step against a stub boundary and the supervisor against a fake
`trainer`.

## Settings

`launch/settings.ts` reads `MAILWOMAN_MODAL_APP`, `MAILWOMAN_MODAL_VOLUME`, `MAILWOMAN_MODAL_TRAIN_GPU`,
`MAILWOMAN_MODAL_TRAIN_RETRIES` and `MAILWOMAN_MODAL_R2_SECRET` with the Python launcher's defaults, over the corpus
package's view. That view holds `MAILWOMAN_DATA_ROOT` and `MAILWOMAN_VOLUME_MOUNT`. Modal credentials come from
`MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` or `~/.modal.toml`.

The default GPU is the A100-40GB. On the 29.6 M-parameter model at batch 128 in bf16, the Rust trainer ran 15.46
steps/s on it, 9.95 on an A10 and 6.96 on an L4, in sandboxes of 8 CPUs and 32 GiB. With that request's $0.63 per
hour added, the A100-40GB and the A10 cost about the same per step, and the A100 finishes sooner. The A100-80GB costs
$0.40 per hour more for memory this model does not use. `launch/wall-clock.ts` records each rate. A GPU sandbox now
requests 4 CPUs and 16 GiB, $0.32 per hour less: the trainer held 7.1 GiB resident in the 90,000-step run of #2884.

## Building the trainer on the host

`node packages/mailwoman/tools/training/libtorch.run.ts` installs the libtorch archive `launch/image.ts` pins into the
git-ignored `.cache/libtorch`, after checking its sha256. The root `.cargo/config.toml` points `LIBTORCH` there, and the
trainer crates' build scripts give their binaries and tests an rpath to its `lib/`, so `cargo test -p trainer-loop` runs
with no variable set. CI downloads the same archive in its `rust` job and sets `LIBTORCH` itself.

## Host audits

The audits under `audits/` read the corpus through the `mtf-node` addon on a host that mirrors the volume at
`MAILWOMAN_DATA_ROOT`. Each writes the report the preflight records:

```bash
node packages/mailwoman/tools/training/audits/epoch/mixture.run.ts --config <yaml> --json <path>
node packages/mailwoman/tools/training/audits/validation/coverage.run.ts <yaml> --json <path>
node packages/mailwoman/tools/training/audits/label/support.run.ts <yaml> --json <path>
```
