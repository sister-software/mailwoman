"""
Modal remote training wrapper for mailwoman v0.5.0 CE-only classifier.

Pulls corpus + tokenizer + training code from Cloudflare R2 into a Modal Volume,
then runs the full 50K-step CE-only train on an A100. Results (checkpoints, ONNX,
model card, train log) are written back to the volume for download.

Usage:
    # First time: sync corpus from R2 (takes ~3 min at datacenter speed)
    modal run scripts/modal/train_remote.py::sync_corpus

    # Run the training (~1h on A100)
    modal run scripts/modal/train_remote.py

    # Download results
    modal volume get mailwoman-training /output/ ./output/
"""

import os
import subprocess
import modal

# ---------------------------------------------------------------------------
# App + Volume + Image
# ---------------------------------------------------------------------------

app = modal.App("mailwoman-training")

vol = modal.Volume.from_name("mailwoman-training")

# Image with PyTorch (CUDA), rclone, sentencepiece, pyarrow, onnx
training_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("curl", "unzip")
    .run_commands(
        # Install rclone for R2 sync
        "curl -sSL https://rclone.org/install.sh | bash",
    )
    .pip_install(
        "torch",
        "sentencepiece>=0.2.0",
        "pyarrow>=15",
        "pyyaml>=6",
        "numpy>=1.26,<3",
        "transformers>=4.41",
        "datasets>=2.19",
        "onnx>=1.16",
        "onnxruntime>=1.18",
        "onnxscript>=0.1",
        "tqdm>=4.66",
    )
)

# R2 credentials — reads from local .env at deploy time via dotenv fallback.
# The script loads .env itself so `source .env` before `modal run` is NOT required.
def _load_r2_env() -> dict[str, str]:
    """Read RCLONE_S3_* from .env, falling back to os.environ."""
    env: dict[str, str] = {}
    env_file = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
    if os.path.isfile(env_file):
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, val = line.partition("=")
                    if key.startswith("RCLONE_S3_"):
                        env[key] = val
    # os.environ overrides file values
    for key in ["RCLONE_S3_PROVIDER", "RCLONE_S3_ACCESS_KEY_ID", "RCLONE_S3_SECRET_ACCESS_KEY",
                "RCLONE_S3_ENDPOINT", "RCLONE_S3_REGION", "RCLONE_S3_NO_CHECK_BUCKET"]:
        if key in os.environ:
            env[key] = os.environ[key]
    return env

r2_secret = modal.Secret.from_dict(_load_r2_env())

BUCKET = "mailwoman-assets"
VOL_MOUNT = "/data"
OUTPUT_DIR = "/data/output"

# ---------------------------------------------------------------------------
# Sync corpus from R2 into the volume
# ---------------------------------------------------------------------------

@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=3600,
)
def sync_corpus():
    """Pull corpus + tokenizer + training code from R2 into the Modal volume."""
    print("Syncing corpus from R2...")

    commands = [
        f"rclone copy :s3:{BUCKET}/corpus/v0.3.0/ {VOL_MOUNT}/corpus/versioned/v0.3.0/corpus-v0.3.0/ --transfers 16 --checkers 32 --stats 30s --stats-log-level NOTICE",
        f"rclone copy :s3:{BUCKET}/corpus/v0.4.0/ {VOL_MOUNT}/corpus/versioned/v0.4.0/corpus-v0.4.0/ --transfers 8",
        f"rclone copy :s3:{BUCKET}/models/tokenizer/ {VOL_MOUNT}/models/tokenizer/ --transfers 4",
        f"rclone copy :s3:{BUCKET}/corpus-python/ {VOL_MOUNT}/corpus-python/ --transfers 4",
    ]

    for i, cmd in enumerate(commands):
        print(f"\n[{i+1}/{len(commands)}] {cmd.split('/')[-1][:60]}...")
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"STDERR: {result.stderr[:500]}")
            raise RuntimeError(f"rclone failed: {result.stderr[:200]}")
        if result.stdout:
            print(result.stdout[-300:])

    vol.commit()
    print("\nCorpus sync complete. Volume committed.")

    # Verify
    for d in ["corpus/versioned/v0.3.0", "corpus/versioned/v0.4.0", "models/tokenizer", "corpus-python"]:
        path = f"{VOL_MOUNT}/{d}"
        if os.path.isdir(path):
            count = sum(1 for _ in os.scandir(path) if True)
            print(f"  {d}: {count} entries")
        else:
            print(f"  {d}: MISSING")


# ---------------------------------------------------------------------------
# Training function
# ---------------------------------------------------------------------------

@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    gpu="A100",
    timeout=14400,  # 4h max (training should take ~1h)
    memory=32768,  # 32GB RAM
)
def train(
    config_name: str = "v0_5_0-classifier-ce-only-full.yaml",
    resume: str = "auto",
):
    """Run the CE-only classifier training on an A100."""
    import sys
    import torch

    # Add training code to path
    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")

    print(f"PyTorch: {torch.__version__}")
    print(f"CUDA available: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"GPU: {torch.cuda.get_device_name(0)}")
        print(f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB")

    # Verify corpus exists
    train_dir = f"{VOL_MOUNT}/corpus/versioned/v0.3.0/corpus-v0.3.0/train"
    if not os.path.isdir(train_dir):
        raise RuntimeError(f"Corpus not found at {train_dir}. Run sync_corpus first.")

    shard_count = len([f for f in os.listdir(train_dir) if f.endswith(".parquet")])
    print(f"Corpus: {shard_count} train shards")

    # The config file references paths relative to /data/ which matches our volume mount
    config_path = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/{config_name}"
    if not os.path.isfile(config_path):
        raise RuntimeError(f"Config not found: {config_path}")

    print(f"Config: {config_name}")
    print(f"Resume: {resume}")
    print("Starting training...\n")

    # Import and run training
    from mailwoman_train.config import Config, _merge
    from mailwoman_train.train import train as run_train

    import yaml
    cfg = Config()
    _merge(cfg, yaml.safe_load(open(config_path)))

    # Override output dir to write to the volume
    cfg.train.output_dir = f"{OUTPUT_DIR}/checkpoints"
    cfg.train.csv_log_path = f"{OUTPUT_DIR}/train_log.csv"

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    if resume == "auto":
        run_train(cfg, resume_from="auto")
    else:
        run_train(cfg)

    vol.commit()
    print(f"\nTraining complete. Output at {OUTPUT_DIR}/")

    # List what we produced
    for root, dirs, files in os.walk(OUTPUT_DIR):
        for f in files:
            path = os.path.join(root, f)
            size = os.path.getsize(path)
            print(f"  {os.path.relpath(path, OUTPUT_DIR)}: {size / 1e6:.1f} MB")


# ---------------------------------------------------------------------------
# Local entrypoint
# ---------------------------------------------------------------------------

@app.local_entrypoint()
def main(
    sync: bool = False,
    config: str = "v0_5_0-classifier-ce-only-full.yaml",
    resume: str = "auto",
):
    """
    Run the mailwoman training pipeline on Modal.

    --sync     Pull corpus from R2 first (only needed once)
    --config   Training config YAML filename
    --resume   Resume mode: 'auto' (find latest checkpoint) or 'none'
    """
    if sync:
        print("Syncing corpus from R2 into Modal volume...")
        sync_corpus.remote()
        print("Corpus sync complete.")
        print("\nTo train, run without --sync:")
        print(f"  modal run scripts/modal/train_remote.py --config {config}")
        return

    print(f"Training with config={config}, resume={resume}...")
    train.remote(config_name=config, resume=resume)
    print("\nTraining complete!")
    print(f"\nDownload results with:\n  modal volume get mailwoman-training /output/ ./output/")


@app.function(
    volumes={VOL_MOUNT: vol},
    image=training_image,
    timeout=600,
)
def export_onnx():
    """Export the step-050000 checkpoint to ONNX."""
    import sys
    from pathlib import Path
    sys.path.insert(0, "/data/corpus-python/src")

    from mailwoman_train.model import MailwomanCoarseEncoder
    from mailwoman_train.export_onnx import export_to_onnx
    from mailwoman_train.tokenizer import Tokenizer

    import torch
    ck_dir = Path("/data/output/checkpoints/step-050000")
    tokenizer = Tokenizer(Path("/data/models/tokenizer/v0.5.0-a1/tokenizer.model"))

    # Load on CPU — checkpoint was saved from CUDA, export function has no GPU
    # Monkey-patch torch.load to force CPU before from_pretrained calls it
    _orig_load = torch.load
    torch.load = lambda *a, **kw: _orig_load(*a, **{**kw, "map_location": "cpu"})
    model = MailwomanCoarseEncoder.from_pretrained(ck_dir)
    torch.load = _orig_load

    out_path = Path("/data/output/model.onnx")
    print(f"Exporting {ck_dir} → {out_path}")
    export_to_onnx(model, out_path, opset=17, max_length=128, pad_token_id=tokenizer.pad_id)
    print(f"ONNX exported: {out_path} ({out_path.stat().st_size / 1e6:.1f} MB)")

    vol.commit()
    print("Committed to volume.")
