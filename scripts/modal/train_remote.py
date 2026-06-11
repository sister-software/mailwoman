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
        # --- PINNED export/quant toolchain (2026-06-09) ---------------------------------
        # These five drive the ONNX graph that ships to browsers. They were UNPINNED (`>=`)
        # and drifted between v0.9.3 (Jun-6) and v0.9.7 (Jun-8): transformers→5.x and
        # onnx→1.21 started rejecting a dynamo-emitted value_info during int8 quant (see
        # mailwoman_train/quantize.py's value_info strip). Pinned to the exact set that
        # produced the v4.1.0 int8 artifact, VERIFIED graph-identical (opset 17, same
        # 28×DynamicQuantizeLinear/MatMulInteger, 0 reverse-slices) to the Safari-proven
        # v0.9.3 graph. INVARIANT: the int8 graph (opset + quant op scheme) must stay
        # within what the pinned `onnxruntime-web` native WebGPU EP runs on Metal (the
        # JSEP int8-dequant slice bug — neural-web uses onnxruntime-web/webgpu). A bump
        # here that raises the opset or changes the quant scheme is a Safari decision, not
        # a free upgrade — re-verify on a real iOS device (CI cannot exercise WebGPU).
        # Query the live image set with `modal run scripts/modal/train_remote.py::versions`.
        "torch==2.12.0",
        "transformers==5.9.0",
        "onnx==1.21.0",
        "onnxruntime==1.26.0",
        "onnxscript==0.7.0",
        # --- non-graph deps (unpinned floors are fine) ---------------------------------
        "sentencepiece>=0.2.0",
        "pyarrow>=15",
        "pyyaml>=6",
        "numpy>=1.26,<3",
        "datasets>=2.19",
        "tqdm>=4.66",
        # Optional experiment tracking — streamed to a Hugging Face Space dashboard when
        # the run config sets train.trackio_enabled (best-effort, see trackio_logging.py).
        "trackio",
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


# HF token for Trackio's Hugging Face Space upload. Reads HF_TOKEN (or the
# HUGGING_FACE_HUB_TOKEN alias) from the local .env at deploy time, falling back to
# os.environ. Empty when unset — Trackio logging then degrades to CSV-only (the upload
# 401s and trackio_logging.py swallows it), so a token is only needed to push the
# dashboard to a Space.
def _load_hf_env() -> dict[str, str]:
    env: dict[str, str] = {}
    env_file = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
    if os.path.isfile(env_file):
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, val = line.partition("=")
                    if key in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
                        env[key] = val
    for key in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
        if key in os.environ:
            env[key] = os.environ[key]
    return env


hf_secret = modal.Secret.from_dict(_load_hf_env())

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
    secrets=[hf_secret],  # HF_TOKEN for optional Trackio Space upload (empty/no-op when unset)
    gpu="A100",
    timeout=14400,  # 4h max (training should take ~1h)
    memory=32768,  # 32GB RAM
)
def train(
    config_name: str = "v0_5_0-classifier-ce-only-full.yaml",
    resume: str = "auto",
    trackio: bool = False,
    trackio_space: str = "",
):
    """Run the CE-only classifier training on an A100.

    Pass ``--trackio`` (and optionally ``--trackio-space org/space``) to mirror metrics
    to a Hugging Face Space dashboard. These override the YAML config's trackio fields;
    omit them to honor whatever the config sets (default: tracking off).
    """
    import sys
    import torch

    # Fetch the latest committed volume state. Without this, a container mounts a stale
    # snapshot and never sees shards added via `modal volume put` after deploy — which silently
    # trains on the old corpus (the v0.7.1 intersection-shard trap, night-3 2026-05-29).
    vol.reload()

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
    cfg.train.csv_log_path = cfg.train.csv_log_path.replace("{output_dir}", run_output) if "{output_dir}" in cfg.train.csv_log_path else f"{run_base}/train_log.csv"

    os.makedirs(run_base, exist_ok=True)

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
    trackio: bool = False,
    trackio_space: str = "",
):
    """
    Run the mailwoman training pipeline on Modal.

    --sync           Pull corpus from R2 first (only needed once)
    --config         Training config YAML filename
    --resume         Resume mode: 'auto' (find latest checkpoint) or 'none'
    --trackio        Mirror metrics to a Hugging Face Space dashboard (Trackio)
    --trackio-space  HF Space id for the dashboard, e.g. sister-software/mailwoman-trackio
    """
    if sync:
        print("Syncing corpus from R2 into Modal volume...")
        sync_corpus.remote()
        print("Corpus sync complete.")
        print("\nTo train, run without --sync:")
        print(f"  modal run scripts/modal/train_remote.py --config {config}")
        return

    print(f"Training with config={config}, resume={resume}, trackio={trackio}...")
    train.remote(config_name=config, resume=resume, trackio=trackio, trackio_space=trackio_space)
    print("\nTraining complete!")
    print(f"\nDownload results with:\n  modal volume get mailwoman-training /output/ ./output/")


@app.function(volumes={VOL_MOUNT: vol}, image=training_image, timeout=600)
def run_tests(pattern: str = ""):
    """Run the corpus-python pytest suite INSIDE the training image (torch available) against the
    volume's code. Exists because torch-dependent tests skip on the local venv — verify loss-path
    changes here BEFORE spending GPU on a probe. Usage:
    ``modal run scripts/modal/train_remote.py::run_tests --pattern test_conventions``"""
    import subprocess
    import sys

    # The training image ships without pytest; install container-locally (ephemeral, ~3s).
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "pytest"], check=True)
    args = [sys.executable, "-m", "pytest", "/data/corpus-python/src/mailwoman_train/", "-q"]
    if pattern:
        args += ["-k", pattern]
    proc = subprocess.run(args, capture_output=True, text=True)
    print(proc.stdout[-4000:])
    if proc.returncode != 0:
        print(proc.stderr[-2000:])
        raise SystemExit(proc.returncode)


@app.function(image=training_image, timeout=120)
def versions():
    """Print the export/quant toolchain versions baked into ``training_image``.

    Used to capture the exact versions for pinning (the unpinned ``>=`` deps drifted
    between v0.9.3 and v0.9.7 and broke int8 quant — see scripts/modal pins + quantize.py).
    Run: ``modal run scripts/modal/train_remote.py::versions``
    """
    import torch, transformers, onnx, onnxruntime, onnxscript, sys
    print(f"python      {sys.version.split()[0]}")
    print(f"torch       {torch.__version__}")
    print(f"transformers {transformers.__version__}")
    print(f"onnx        {onnx.__version__}")
    print(f"onnxruntime {onnxruntime.__version__}")
    print(f"onnxscript  {onnxscript.__version__}")


@app.function(
    volumes={VOL_MOUNT: vol},
    image=training_image,
    timeout=600,
)
def export_onnx(
    output_dir: str = "",
    step: str = "",
    tokenizer_path: str = "",
):
    """Export a checkpoint to ONNX.

    Parameters accepted via ``modal run scripts/modal/train_remote.py::export_onnx
    --output-dir=/data/output-v062 --step=20000``. Env-var fallbacks
    (MAILWOMAN_EXPORT_OUTPUT_DIR / MAILWOMAN_EXPORT_STEP / MAILWOMAN_EXPORT_TOKENIZER)
    are kept for back-compat with prior workflows; CLI params take precedence when set.
    """
    import sys
    from pathlib import Path
    sys.path.insert(0, "/data/corpus-python/src")

    from mailwoman_train.model import MailwomanCoarseEncoder
    from mailwoman_train.export_onnx import export_to_onnx
    from mailwoman_train.tokenizer import Tokenizer

    import torch
    import os
    output_dir = output_dir or os.environ.get("MAILWOMAN_EXPORT_OUTPUT_DIR", "/data/output-v054")
    step = step or os.environ.get("MAILWOMAN_EXPORT_STEP", "100000")
    tokenizer_path = tokenizer_path or os.environ.get(
        "MAILWOMAN_EXPORT_TOKENIZER", "/data/models/tokenizer/v0.6.0-a0/tokenizer.model"
    )

    ck_dir = Path(f"{output_dir}/checkpoints/step-{step}")
    tokenizer = Tokenizer(Path(tokenizer_path))

    _orig_load = torch.load
    torch.load = lambda *a, **kw: _orig_load(*a, **{**kw, "map_location": "cpu"})
    model = MailwomanCoarseEncoder.from_pretrained(ck_dir)
    torch.load = _orig_load

    out_path = Path(f"{output_dir}/model.onnx")
    print(f"Exporting {ck_dir} → {out_path}")
    export_to_onnx(model, out_path, opset=17, max_length=128, pad_token_id=tokenizer.pad_id)
    print(f"ONNX exported: {out_path} ({out_path.stat().st_size / 1e6:.1f} MB)")

    vol.commit()
    print("Committed to volume.")


@app.function(
    volumes={VOL_MOUNT: vol},
    image=training_image,
    timeout=600,
)
def quantize_onnx(
    fp32_path: str = "",
    int8_path: str = "",
):
    """Int8-quantize an fp32 ONNX on the volume, in the training image.

    The dynamo-exported graph (see ``export_to_onnx``) trips onnx shape inference in some
    *local* onnxruntime builds (``quantize_dynamic`` / the ORT pre-process both fail with a
    ShapeInferenceError). The training image's pinned onnxruntime quantizes it cleanly, so we
    do int8 here next to ``export_onnx`` rather than locally.

    Usage: ``modal run scripts/modal/train_remote.py::quantize_onnx
    --fp32-path=/data/output-v097-unit-v3-s42/model.onnx
    --int8-path=/data/models/quantized/model-v097-step-20000-int8.onnx``
    """
    from pathlib import Path
    import sys
    sys.path.insert(0, "/data/corpus-python/src")
    from mailwoman_train.quantize import quantize_dynamic_int8

    fp32 = Path(fp32_path)
    int8 = Path(int8_path)
    print(f"Quantizing {fp32} → {int8}")
    quantize_dynamic_int8(fp32, int8)
    print(f"int8 written: {int8} ({int8.stat().st_size / 1e6:.1f} MB)")
    vol.commit()
    print("Committed to volume.")


@app.function(
    volumes={VOL_MOUNT: vol},
    image=training_image,
    timeout=600,
)
def diagnose_corpus(
    corpus_dir: str = "/data/corpus/versioned/v0.4.0/corpus-v0.4.0",
    verify_country: str = "",
    verify_source: str = "",
):
    """Check which corpus shards the data loader actually sees on the Modal volume.

    Pass ``--corpus-dir`` to point at an overlay (e.g. the v0.4.1-de pilot corpus). Pass
    ``--verify-country DE --verify-source synth-german`` to additionally PULL a few rows through the
    real filter and confirm they survive — the night-4 trap was a German shard whose rows were all
    filtered out, so the run trained on nothing. This is the pre-launch "verify the loader sees the
    shard, THEN launch" gate.
    """
    import json
    import random
    import sys
    from collections import Counter
    from pathlib import Path

    vol.reload()  # see shards added via `modal volume put` after deploy
    sys.path.insert(0, "/data/corpus-python/src")

    corpus_dir = Path(corpus_dir)
    manifest = corpus_dir / "MANIFEST.json"

    print(f"Corpus dir: {corpus_dir}")
    print(f"Manifest exists: {manifest.exists()}")

    if manifest.exists():
        data = json.loads(manifest.read_text())
        train_shards = [s for s in data.get("shards", []) if s.get("split") == "train"]
        print(f"MANIFEST: {len(train_shards)} train shards, {sum(s['rows'] for s in train_shards):,} rows")

        existing = sum(1 for s in train_shards if Path(s["path"]).exists())
        missing = len(train_shards) - existing
        print(f"Train shard files: {existing} exist, {missing} missing")
        if missing > 0:
            for s in train_shards:
                if not Path(s["path"]).exists():
                    print(f"  MISSING: {s['path']}")
                    break

    from mailwoman_train.data_loader import _shard_paths, _shard_first_source

    paths = _shard_paths(corpus_dir, "train")
    print(f"\n_shard_paths returned {len(paths)} train shards")

    by_source: Counter[str] = Counter()
    errors = 0
    for p in paths:
        if not p.exists():
            errors += 1
            continue
        try:
            src = _shard_first_source(p)
            by_source[src] += 1
        except Exception as exc:
            errors += 1
            if errors <= 3:
                print(f"  ERROR reading {p}: {exc}")

    print(f"\nSource index ({errors} errors, {sum(by_source.values())} readable):")
    for src, count in by_source.most_common():
        print(f"  {src:35s} {count:4d} shards")

    # Pre-launch verification: do rows of the target country/source actually survive the filter?
    if verify_country or verify_source:
        from mailwoman_train.data_loader import iter_rows
        from mailwoman_train.labels import locale_id

        cw = {c: 1.0 for c in (verify_country.split(",") if verify_country else ["US", "FR", "DE"])}
        sw = {verify_source: 1.0} if verify_source else None
        rows = list(iter_rows(
            corpus_dir, "train", rng=random.Random(0),
            country_weights=cw, source_weights=sw, coarse_filter=True, row_limit=5,
        ))
        print(f"\n[verify] rows passing filter (country={cw}, source={sw}): {len(rows)}")
        for r in rows[:3]:
            print(f"  country={r['country']} locale_id={locale_id(r['country'])} raw={r['raw'][:60]}")
        if not rows:
            print("  !! ZERO rows — the run would train on nothing. Do NOT launch.")


@app.function(
    volumes={VOL_MOUNT: vol},
    image=training_image,
    timeout=900,
)
def eval_de(
    output_dir: str,
    step: str,
    anchor_lookup: str = "",
    anchor_off: bool = False,
    val_path: str = "/data/corpus/versioned/v0.4.1-de/corpus-v0.4.1-de/val/part-german-val.parquet",
    tokenizer_path: str = "/data/models/tokenizer/v0.6.0-a0/tokenizer.model",
    max_rows: int = 4000,
):
    """DE-locality readout for the anchor pilot (#239/#240): per-tag PARSER F1 on the German val for
    one checkpoint. The German collapse shows as a low locality/postcode F1 (with street/house# up);
    the anchor fix as a recovered locality. ``anchor_lookup`` set → feed the real anchor;
    ``anchor_off=True`` → feed the features but force confidence 0 (the anchor-free degradation gate).
    Forwards + argmax (CRF weight is 0, so the trained signal is in the emissions)."""
    import sys
    from pathlib import Path

    vol.reload()
    sys.path.insert(0, "/data/corpus-python/src")
    import torch
    import pyarrow.parquet as pq

    from mailwoman_train.model import MailwomanCoarseEncoder
    from mailwoman_train.tokenizer import Tokenizer, encode_row
    from mailwoman_train.train import _token_f1
    from mailwoman_train.data_loader import load_anchor_lookup
    from mailwoman_train.labels import ACTIVE_BIO_LABELS

    ck = Path(f"{output_dir}/checkpoints/step-{step}")
    tok = Tokenizer(Path(tokenizer_path))
    _orig = torch.load
    torch.load = lambda *a, **kw: _orig(*a, **{**kw, "map_location": "cpu"})
    model = MailwomanCoarseEncoder.from_pretrained(ck).eval()
    torch.load = _orig
    lookup = load_anchor_lookup(anchor_lookup) if anchor_lookup else None

    rows = pq.read_table(val_path).to_pylist()[:max_rows]
    all_preds, all_labels = [], []
    B = 128
    for i in range(0, len(rows), B):
        chunk = rows[i : i + B]
        ids, masks, labs, afeats, aconfs = [], [], [], [], []
        for r in chunk:
            enc = encode_row(tok, r["raw"], r["tokens"], r["labels"], 128, anchor_lookup=lookup)
            ids.append(enc["input_ids"])
            masks.append(enc["attention_mask"])
            labs.append(enc["labels"])
            if lookup:
                afeats.append(enc["anchor_features"])
                aconfs.append([0.0] * 128 if anchor_off else enc["anchor_confidence"])
        kw = {}
        if lookup:
            kw = {
                "anchor_features": torch.tensor(afeats, dtype=torch.float32),
                "anchor_confidence": torch.tensor(aconfs, dtype=torch.float32),
            }
        with torch.no_grad():
            out = model(torch.tensor(ids), attention_mask=torch.tensor(masks), **kw)
        all_preds.append(out.logits.argmax(-1))
        all_labels.append(torch.tensor(labs))

    preds = torch.cat(all_preds)
    labels = torch.cat(all_labels)
    m = _token_f1(preds, labels, num_labels=len(ACTIVE_BIO_LABELS))
    g = lambda t: m.get(f"f1_tag.{t}", float("nan"))
    mode = "anchor-OFF" if (anchor_off or not lookup) else "anchor-ON "
    print(
        f"[DE eval] {ck.name} {mode}: locality={g('locality'):.3f}  postcode={g('postcode'):.3f}  "
        f"region={g('region'):.3f}  street={g('street'):.3f}  house_number={g('house_number'):.3f}  "
        f"macro_f1={m.get('macro_f1', float('nan')):.3f}  (n={len(rows)})"
    )
