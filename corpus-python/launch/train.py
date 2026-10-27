"""The GPU training run, the CPU preflight in front of it, and the command-line entry point.

    modal run -d -m launch.train_remote --config <recipe>.yaml [--fresh] [--branch-from <checkpoint>] [--gpu <type>]

Stage what the recipe reads first, with `launch/syncs.py`; this module trains against whatever is
already on the volume.

The entry point runs `preflight` on CPU and blocks on it, then spawns the GPU function and returns. The
preflight hashes the corpus files into the volume's sha256 cache, runs every audit the config declares,
checks the wall-clock budget, and writes a receipt keyed by the config's sha256 and the MANIFEST's file
sha256 set. The GPU function verifies that receipt and refuses to start without it, so a failed audit
never bills a GPU and the GPU never rehashes the corpus.

The GPU function is spawned rather than called with `.remote()`. Modal cancels a synchronous input
within minutes of its client disconnecting, and a spawned call is independent of the client once the
app is detached (`modal run -d`). The entry point prints the call id; `python -m launch.call_status
<id>` reads its state later from any shell.

The function retries under `modal.Retries`. Every attempt resumes from the newest complete checkpoint in
the run's output directory (`launch/resume.py`), so a preempted attempt continues rather than restarts.
"""

from __future__ import annotations

import os

import modal

from .app import VOL_MOUNT, app, hf_secret, training_image, vol
from .resume import check_clearable, resolve_run_paths, resume_point
from .settings import settings

# Training-function wall-clock budget per attempt: 32,400 s (9h) covers a 90k A100 recipe, which the estimate below
# puts at about 30,400 s. The preflight checks any recipe against the ceiling, so a config that cannot fit fails before
# a GPU is billed.
TRAIN_TIMEOUT_SECONDS = 32400
# ~4.25 optimizer steps/s at batch 128, measured on the A100 40 GB. The default GPU is the 80 GB card. It has
# the same compute and more memory bandwidth, so this rate stays a conservative bound. A launch on
# a smaller `--gpu` is not covered by this measurement.
MEASURED_STEPS_PER_SECOND = 4.25
# Multiplicative headroom over the measured rate (validation pauses, checkpoint writes, slow
# batches) plus a flat allowance for startup/shutdown outside the step loop.
TIMEOUT_HEADROOM = 1.35
STARTUP_SHUTDOWN_OVERHEAD_SECONDS = 1800

#: The audits a receipt records, by name. The GPU run requires the subset its config declares.
CORPUS_FILES = "corpus_files"
CORPUS_RECEIPTS = "corpus_receipts"
VALIDATION_COVERAGE = "validation_coverage"
VALIDATION_LABEL_SUPPORT = "validation_label_support"
WALL_CLOCK = "wall_clock"


def _required_train_seconds(max_steps: int) -> int:
    """Conservative wall-clock estimate for a run of ``max_steps`` optimizer steps."""
    return int(max_steps / MEASURED_STEPS_PER_SECOND * TIMEOUT_HEADROOM) + STARTUP_SHUTDOWN_OVERHEAD_SECONDS


def required_audits(cfg: object) -> list[str]:
    """The audits a config's receipt must record: the always-on ones plus each the config declares."""
    data = getattr(cfg, "data")  # noqa: B009 -- typed loosely so this module imports no training package
    audits = [CORPUS_FILES, WALL_CLOCK]
    if data.required_corpus_receipts:
        audits.append(CORPUS_RECEIPTS)
    if data.required_validation_coverage:
        audits.append(VALIDATION_COVERAGE)
    if data.required_validation_label_support:
        audits.append(VALIDATION_LABEL_SUPPORT)
    return audits


def check_source_rights(config_name: str) -> None:
    """Refuse a config admitting a source whose register rows lack a transform and train permission.

    This runs in the local entry point, before anything is billed, because the register and the corpus-source
    table live in the repository checkout and the Modal volume holds only `corpus-python/src`. A config that
    sets `data.unshippable_reason` passes, and the run writes `SOURCE_RIGHTS.json` marking it not shippable.
    """
    from mailwoman_train.config import load_training_config
    from mailwoman_train.paths import package_path

    _cfg, rights = load_training_config(package_path("configs", config_name))
    if rights.shippable:
        print(f"Source rights: {len(rights.sources_checked)} admitted sources permit transform and train")
    else:
        print(f"Source rights: NOT SHIPPABLE ({rights.unshippable_reason}); {len(rights.gaps)} gap(s) logged above")


def _config_path(config_name: str) -> str:
    path = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/{config_name}"
    if not os.path.isfile(path):
        raise RuntimeError(f"Config not found: {path}")
    return path


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    timeout=7200,
    memory=16384,
)
def preflight(config_name: str, fresh: bool = False) -> str:
    """Run every pre-training audit on CPU, write the receipt, and return its key as the GPU run's token.

    ``fresh`` clears the run's output directory once, here, so no GPU attempt ever deletes a checkpoint.
    """
    import shutil
    import sys
    from pathlib import Path

    vol.reload()
    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")
    config_path = Path(_config_path(config_name))

    from mailwoman_train.audits.preflight import write_receipt
    from mailwoman_train.config import load_config
    from mailwoman_train.data.loader.corpus_files import corpus_split_files

    cfg = load_config(config_path)
    audits_dir = Path(f"{VOL_MOUNT}/audits")
    corpus_dir = Path(cfg.data.corpus_dir)
    reports: dict[str, str] = {}

    try:
        # Lists and hashes every split's files against the MANIFEST, filling the volume's sha256 cache.
        try:
            train_files = corpus_split_files(corpus_dir, "train")
        except FileNotFoundError as error:
            raise RuntimeError(
                f"Corpus not found under cfg.data.corpus_dir={corpus_dir}: {error}. "
                "Stage it first: `modal run -m launch.train_remote::sync --version <name>`."
            ) from error
        print(f"Corpus: {corpus_dir} ({len(train_files)} train parquet files)")
        for split in ("val", "test"):
            try:
                print(f"Corpus {split}: {len(corpus_split_files(corpus_dir, split))} parquet files")
            except FileNotFoundError:
                print(f"Corpus {split}: none listed")

        if cfg.data.required_corpus_receipts:
            from mailwoman_train.audits.epoch_mixture import run as run_receipts

            report_path = audits_dir / f"epoch-mixture-{config_path.stem}.json"
            run_receipts(config_path, json_path=report_path)
            reports[CORPUS_RECEIPTS] = str(report_path)
            print(f"Corpus receipts: verified ({len(cfg.data.required_corpus_receipts)} requirements)")

        if cfg.data.required_validation_coverage:
            # A locale the release requirements cover needs a validation split able to show a regression
            # against the shipped model. Without one, `evaluate()` reports the same numbers whatever
            # happened to that locale, and the run reads as clean.
            from mailwoman_train.audits.validation_coverage import expand_requirements
            from mailwoman_train.audits.validation_coverage import run as run_coverage

            coverage = expand_requirements(cfg.data.required_validation_coverage, cfg.data.country_weights)
            report_path = audits_dir / f"validation-coverage-{config_path.stem}.json"
            run_coverage(
                config_path,
                json_path=report_path,
                countries=tuple(sorted({entry.country.upper() for entry in coverage})),
            )
            reports[VALIDATION_COVERAGE] = str(report_path)
            print(f"Validation coverage: verified ({len(coverage)} floors)")

        if cfg.data.required_validation_label_support:
            # `macro_f1` weighs every supported label equally, so a label held by a few validation rows
            # moves the headline score as much as one held by thousands.
            from mailwoman_train.audits.label_support import run as run_label_support

            report_path = audits_dir / f"label-support-{config_path.stem}.json"
            run_label_support(config_path, json_path=report_path)
            reports[VALIDATION_LABEL_SUPPORT] = str(report_path)
            print(f"Validation label support: verified ({len(cfg.data.required_validation_label_support)} labels)")

        required = _required_train_seconds(cfg.train.max_steps)
        if required > TRAIN_TIMEOUT_SECONDS:
            raise RuntimeError(
                f"cfg.train.max_steps={cfg.train.max_steps} needs ~{required}s wall clock "
                f"({MEASURED_STEPS_PER_SECOND} steps/s measured, ×{TIMEOUT_HEADROOM} headroom, "
                f"+{STARTUP_SHUTDOWN_OVERHEAD_SECONDS}s startup/shutdown) but the train function's "
                f"timeout is {TRAIN_TIMEOUT_SECONDS}s. Raise TRAIN_TIMEOUT_SECONDS deliberately; "
                "do not let Modal kill the run at the wire."
            )
        print(f"Wall-clock preflight: ~{required}s required of {TRAIN_TIMEOUT_SECONDS}s budget")

        token = write_receipt(audits_dir, config_path, corpus_dir, required_audits(cfg), reports)
        print(f"Preflight receipt: {audits_dir}/preflight-{token}.json")

        if fresh:
            paths = resolve_run_paths(cfg.train.output_dir, cfg.train.csv_log_path, VOL_MOUNT)
            check_clearable(paths.output_dir, VOL_MOUNT)
            if os.path.isdir(paths.output_dir):
                shutil.rmtree(paths.output_dir)
                print(f"Fresh start: cleared {paths.output_dir}")
    finally:
        # Commit the reports and the sha256 cache whether or not an audit raised, so a rerun reuses the hashes.
        vol.commit()
    return token


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[hf_secret],  # HF_TOKEN for optional Trackio Space upload (empty/no-op when unset)
    gpu=settings().train_gpu,
    # The loader streams in this process (`num_workers` is unread), so extra cores serve pyarrow decoding and
    # torch's CPU threads. The reservation guarantees them rather than relying on burst capacity.
    cpu=8.0,
    timeout=TRAIN_TIMEOUT_SECONDS,
    memory=32768,
    # A preempted or crashed attempt is retried, and every attempt resumes from the run's latest checkpoint.
    retries=modal.Retries(max_retries=settings().train_retries, initial_delay=10.0, backoff_coefficient=2.0),
    # Each attempt gets a new container, so no attempt inherits a CUDA context or loader state from a failed one.
    single_use_containers=True,
)
def _train_gpu(
    config_name: str,
    preflight_token: str,
    branch_from: str = "",
    trackio: bool = False,
    trackio_space: str = "",
) -> None:
    """Train one config on the GPU after verifying its preflight receipt.

    ``branch_from`` names a checkpoint an attempt starts from when the run's own output directory holds
    none (the branch-run mechanism, e.g. a linear cooldown from a mid-cosine checkpoint).
    """
    import sys
    from pathlib import Path

    import torch

    # Fetch the latest committed volume state, including the receipt the preflight committed before this call.
    vol.reload()
    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")

    print(f"PyTorch: {torch.__version__}")
    print(f"CUDA available: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"GPU: {torch.cuda.get_device_name(0)}")
        print(f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB")

    config_path = _config_path(config_name)

    # load_config is the strict path: an unknown YAML key raises here at launch, naming the dotted key and
    # file, instead of silently running a fine-tune with every setting inert.
    from mailwoman_train.audits.preflight import verify_receipt
    from mailwoman_train.config import load_config
    from mailwoman_train.train.checkpoint import find_latest_checkpoint
    from mailwoman_train.train.trainer import train as run_train

    cfg = load_config(config_path)
    verify_receipt(
        Path(f"{VOL_MOUNT}/audits"), Path(config_path), Path(cfg.data.corpus_dir), preflight_token, required_audits(cfg)
    )
    print(f"Preflight receipt: verified ({', '.join(required_audits(cfg))})")

    if trackio:
        cfg.train.trackio_enabled = True
    if trackio_space:
        cfg.train.trackio_space = trackio_space
    if cfg.train.trackio_enabled:
        print(f"Trackio: enabled (space={cfg.train.trackio_space or '(local)'})")

    paths = resolve_run_paths(cfg.train.output_dir, cfg.train.csv_log_path, VOL_MOUNT)
    cfg.train.output_dir = paths.output_dir
    cfg.train.csv_log_path = paths.csv_log_path
    os.makedirs(paths.run_base, exist_ok=True)

    latest = find_latest_checkpoint(Path(paths.output_dir))
    start = resume_point(str(latest) if latest is not None else None, branch_from)
    print(f"Config: {config_name}")
    print(f"Output: {paths.output_dir}")
    print(f"Resume: {start or 'none (from scratch)'}\n")

    run_train(cfg, resume_from=start)

    vol.commit()
    print(f"\nTraining complete. Output at {paths.run_base}/")
    for root, _dirs, files in os.walk(paths.run_base):
        for f in files:
            path = os.path.join(root, f)
            print(f"  {os.path.relpath(path, paths.run_base)}: {os.path.getsize(path) / 1e6:.1f} MB")


@app.local_entrypoint()
def main(
    config: str = "v0_5_0-classifier-ce-only-full.yaml",
    fresh: bool = False,
    branch_from: str = "",
    gpu: str = "",
    trackio: bool = False,
    trackio_space: str = "",
) -> None:
    """
    Preflight a config on CPU, then spawn its GPU training run and print the call id.

    Launch with `modal run -d`: without `--detach` the app stops when this entry point returns, and the
    spawned call stops with it.

    --config         Training config YAML filename
    --fresh          Clear the run's output directory once before training. Without it, the run resumes
                     from its newest checkpoint when one exists
    --branch-from    Checkpoint to start from when the output directory holds none
    --gpu            Modal GPU type for this launch (default: MAILWOMAN_MODAL_TRAIN_GPU, A100-80GB)
    --trackio        Mirror metrics to a Hugging Face Space dashboard (Trackio)
    --trackio-space  HF Space id for the dashboard, e.g. sister-software/mailwoman-trackio
    """
    check_source_rights(config)
    print(f"Preflighting config={config} on CPU{' (fresh start)' if fresh else ''}...")
    token = preflight.remote(config_name=config, fresh=fresh)

    function = _train_gpu.with_options(gpu=gpu) if gpu else _train_gpu
    call = function.spawn(
        config_name=config,
        preflight_token=token,
        branch_from=branch_from,
        trackio=trackio,
        trackio_space=trackio_space,
    )
    print(f"\nSpawned training: function_call_id={call.object_id} gpu={gpu or settings().train_gpu}")
    print(f"Dashboard: {call.get_dashboard_url()}")
    print(f"Status: (cd corpus-python && uv run --extra dev python -m launch.call_status {call.object_id})")
    print(f"Artifacts land under the config's output_dir on the {settings().volume_name} volume; list them with")
    print(f"  modal volume ls {settings().volume_name} <output_dir relative to {VOL_MOUNT}>/")
