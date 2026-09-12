"""The GPU run itself, its wall-clock budget, and the entry point an operator types.

    modal run -d -m launch.train_remote --config <recipe>.yaml --resume auto

Stage what the recipe reads FIRST, with `launch/syncs.py`; this module trains against whatever is
already on the volume. Two preflights run before the GPU is billed — the corpus receipts on CPU, and
the wall-clock estimate against this function's timeout — because both failures are otherwise found
hours in, after the spend.
"""

from __future__ import annotations

import os

from .app import OUTPUT_DIR, VOL_MOUNT, app, hf_secret, training_image, vol

# Training-function wall-clock budget (2026-08-09 P1). The old decorator value was 14,400 s
# under a stale "training should take ~1h" comment, and killed a 60k-step run at step 59,900:
# at the measured throughput 60k optimizer steps alone need ~3h55m, before image boot, volume
# reload, loader init, validation, checkpointing, and the final save/commit. 21,600 s (6h)
# covers the 60k A100 recipe with real headroom, and `_required_train_seconds` preflights any
# recipe against the ceiling INSIDE train() — a config that cannot fit fails in minute one,
# not at the wire.
TRAIN_TIMEOUT_SECONDS = 21600
# Measured on the v4.3.3 A100 run (2026-08-09): ~4.25 optimizer steps/s at batch 128.
MEASURED_STEPS_PER_SECOND = 4.25
# Multiplicative headroom over the measured rate (validation pauses, checkpoint writes, slow
# batches) plus a flat allowance for startup/shutdown outside the step loop.
TIMEOUT_HEADROOM = 1.35
STARTUP_SHUTDOWN_OVERHEAD_SECONDS = 1800


def _required_train_seconds(max_steps: int) -> int:
    """Conservative wall-clock estimate for a run of ``max_steps`` optimizer steps."""
    return int(max_steps / MEASURED_STEPS_PER_SECOND * TIMEOUT_HEADROOM) + STARTUP_SHUTDOWN_OVERHEAD_SECONDS


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    timeout=7200,
    memory=16384,
)
def preflight_corpus_receipts(config_name: str) -> str:
    """Run declared corpus receipts on CPU and return their config+manifest binding."""
    import sys
    from pathlib import Path

    vol.reload()
    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")

    config_path = Path(f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/{config_name}")
    if not config_path.is_file():
        raise RuntimeError(f"Config not found: {config_path}")

    from mailwoman_train.audits.epoch_mixture import CorpusReceiptError, run
    from mailwoman_train.config import load_config

    cfg = load_config(config_path)
    if not cfg.data.required_corpus_receipts:
        return ""

    json_path = Path(f"{VOL_MOUNT}/audits/epoch-mixture-{config_path.stem}.json")
    try:
        report = run(config_path, json_path=json_path)
    except CorpusReceiptError:
        vol.commit()
        raise
    vol.commit()
    return str(report["meta"]["corpus_receipt_binding"])


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[hf_secret],  # HF_TOKEN for optional Trackio Space upload (empty/no-op when unset)
    gpu="A100",
    timeout=TRAIN_TIMEOUT_SECONDS,  # 6h — see the TRAIN_TIMEOUT_SECONDS derivation above
    memory=32768,  # 32GB RAM
)
def _train_gpu(
    config_name: str = "v0_5_0-classifier-ce-only-full.yaml",
    resume: str = "auto",
    trackio: bool = False,
    trackio_space: str = "",
    corpus_receipt_token: str = "",
):
    """Run the CE-only classifier training on an A100.

    Pass ``--trackio`` (and optionally ``--trackio-space org/space``) to mirror metrics
    to a Hugging Face Space dashboard. These override the YAML config's trackio fields;
    omit them to honor whatever the config sets (default: tracking off).
    """
    import sys

    import torch

    # Fetch the latest committed volume state. Without this, a container mounts a stale
    # snapshot and never sees slices added via `modal volume put` after deploy — which silently
    # trains on the old corpus (the v0.7.1 intersection-slice trap, night-3 2026-05-29).
    vol.reload()

    # Add training code to path
    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")

    print(f"PyTorch: {torch.__version__}")
    print(f"CUDA available: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"GPU: {torch.cuda.get_device_name(0)}")
        print(f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB")

    # Corpus existence is verified AFTER the config loads (below), against cfg.data.corpus_dir — the
    # corpus version travels in the config, not hardcoded here. (Was pinned to v0.3.0, which silently
    # blocked every later corpus once v0.3.0 was cleaned off the volume. 2026-06-12.)

    # The config file references paths relative to /data/ which matches our volume mount
    config_path = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/{config_name}"
    if not os.path.isfile(config_path):
        raise RuntimeError(f"Config not found: {config_path}")

    print(f"Config: {config_name}")
    print(f"Resume: {resume}")
    print("Starting training...\n")

    # Import and run training. load_config is the STRICT path (#1248): an unknown YAML
    # key — e.g. a setting the volume-side config schema predates — raises here at launch,
    # naming the dotted key + file, instead of silently running a fine-tune with every setting inert.
    from mailwoman_train.config import load_config
    from mailwoman_train.train.trainer import train as run_train

    cfg = load_config(config_path)

    # Verify the corpus the config actually points at exists on the volume (post-config so the version
    # isn't hardcoded). The data loader reads cfg.data.corpus_dir; fail loud here if it's missing.
    train_dir = os.path.join(cfg.data.corpus_dir, "train")
    if not os.path.isdir(train_dir):
        raise RuntimeError(
            f"Corpus not found at {train_dir} (cfg.data.corpus_dir={cfg.data.corpus_dir}). "
            "Stage it first: `modal run -m launch.train_remote::sync --version <name>`."
        )
    slice_count = len([f for f in os.listdir(train_dir) if f.endswith(".parquet")])
    print(f"Corpus: {cfg.data.corpus_dir} ({slice_count} train slices)")

    if cfg.data.required_corpus_receipts:
        from pathlib import Path

        from mailwoman_train.audits.epoch_mixture import verify_corpus_receipt_report

        receipt_report = Path(f"{VOL_MOUNT}/audits/epoch-mixture-{Path(config_path).stem}.json")
        verify_corpus_receipt_report(
            Path(config_path),
            Path(cfg.data.corpus_dir),
            cfg.data.required_corpus_receipts,
            corpus_receipt_token,
            receipt_report,
        )
        print(f"Corpus receipts: verified ({len(cfg.data.required_corpus_receipts)} requirements)")

    # Preflight the wall-clock budget (2026-08-09 P1): a recipe whose step count cannot fit
    # this function's timeout must fail HERE, not die at the wire like the 60k predecessor
    # that Modal killed at step 59,900.
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

    # CLI overrides for experiment tracking (take precedence over the YAML config).
    if trackio:
        cfg.train.trackio_enabled = True
    if trackio_space:
        cfg.train.trackio_space = trackio_space
    if cfg.train.trackio_enabled:
        print(f"Trackio: enabled (space={cfg.train.trackio_space or '(local)'})")

    # Use config's output_dir if it has one, otherwise default
    run_output = cfg.train.output_dir if cfg.train.output_dir.startswith("/data/") else f"{OUTPUT_DIR}/checkpoints"
    run_base = os.path.dirname(run_output)
    cfg.train.output_dir = run_output
    cfg.train.csv_log_path = (
        cfg.train.csv_log_path.replace("{output_dir}", run_output)
        if "{output_dir}" in cfg.train.csv_log_path
        else f"{run_base}/train_log.csv"
    )

    os.makedirs(run_base, exist_ok=True)

    if resume == "auto":
        run_train(cfg, resume_from="auto")
    elif resume and resume != "none":
        # Explicit checkpoint path — the branch-run mechanism (e.g. the linear_cooldown read of
        # a mid-cosine checkpoint under a NEW output dir). Previously silently dropped, which
        # made every non-auto resume a fresh run.
        run_train(cfg, resume_from=resume)
    else:
        run_train(cfg)

    vol.commit()
    print(f"\nTraining complete. Output at {OUTPUT_DIR}/")

    # List what we produced
    for root, _dirs, files in os.walk(OUTPUT_DIR):
        for f in files:
            path = os.path.join(root, f)
            size = os.path.getsize(path)
            print(f"  {os.path.relpath(path, OUTPUT_DIR)}: {size / 1e6:.1f} MB")


@app.local_entrypoint()
def main(
    config: str = "v0_5_0-classifier-ce-only-full.yaml",
    resume: str = "auto",
    trackio: bool = False,
    trackio_space: str = "",
):
    """
    Run the mailwoman training pipeline on Modal.

    Stage what the recipe reads FIRST, with its own sync; this entry point trains against whatever
    is already on the volume and stages nothing.

    --config         Training config YAML filename
    --resume         Resume mode: 'auto' (find latest checkpoint) or 'none'
    --trackio        Mirror metrics to a Hugging Face Space dashboard (Trackio)
    --trackio-space  HF Space id for the dashboard, e.g. sister-software/mailwoman-trackio
    """
    print(f"Preflighting corpus receipts for config={config}...")
    corpus_receipt_token = preflight_corpus_receipts.remote(config_name=config)
    print(f"Training with config={config}, resume={resume}, trackio={trackio}...")
    _train_gpu.remote(
        config_name=config,
        resume=resume,
        trackio=trackio,
        trackio_space=trackio_space,
        corpus_receipt_token=corpus_receipt_token,
    )
    print("\nTraining complete!")
    print("\nDownload results with:\n  modal volume get mailwoman-training /output/ ./output/")
