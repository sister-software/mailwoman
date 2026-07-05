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
        # #924 NL-postcode overlay (v0.10.1) — the 698 base shards already live on the volume from
        # prior trainings; only the +1 shard + its MANIFEST are new. modal-volume-put is
        # container-blind, so it MUST come through this rclone path to be visible to the trainer.
        f"rclone copy :s3:{BUCKET}/corpus/v0.10.1-nl-postcode/ {VOL_MOUNT}/corpus/versioned/v0.10.1-nl-postcode/ --transfers 4",
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


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=3600,
)
def sync_v050():
    """Pull the v0.5.0 char-offset corpus + current training code (configs incl. v1.4.0) from R2 into
    the volume, CONTAINER-SIDE.

    Why a dedicated path instead of `modal volume put`: on this volume the CLI write -> container read
    path is broken — files put via `modal volume put` are visible to `modal volume ls/get` but NOT to
    a mounted container, and `vol.reload()` does not bridge it (verified 2026-06-12 with a marker
    file). Container-side writes + `vol.commit()` DO propagate. So we route the corpus through R2 (the
    same channel sync_corpus uses) and write it from inside a container. R2 occasionally 501s on a
    PUT/GET; the retry flags ride through it (each op succeeds on a later attempt)."""
    import shutil
    import subprocess

    print("Syncing v0.5.0 from R2 (container-side)...")
    vol.reload()
    R = "--low-level-retries 30 --retries 8 --transfers 12 --checkers 24 --stats 30s --stats-log-level NOTICE"
    commands = [
        f"rclone copy :s3:{BUCKET}/corpus/v0.5.0/corpus-v0.5.0/ {VOL_MOUNT}/corpus/versioned/v0.5.0/corpus-v0.5.0/ {R}",
        f"rclone copy :s3:{BUCKET}/corpus-python/src/ {VOL_MOUNT}/corpus-python/src/ {R}",
    ]
    for i, cmd in enumerate(commands):
        print(f"\n[{i+1}/{len(commands)}] {cmd[:90]}...")
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"STDERR: {result.stderr[:800]}")
            raise RuntimeError(f"rclone failed: {result.stderr[:200]}")
        if result.stdout:
            print(result.stdout[-300:])

    # Clear stale pyc so the freshly-synced loader is what imports (the night-3 pyc gotcha).
    pyc = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/__pycache__"
    if os.path.isdir(pyc):
        shutil.rmtree(pyc)

    vol.commit()
    print("\nv0.5.0 sync complete. Volume committed.")

    tdir = f"{VOL_MOUNT}/corpus/versioned/v0.5.0/corpus-v0.5.0/train"
    cfg = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/v1.4.0-charoffset.yaml"
    print("  v0.5.0 train shards:", len(os.listdir(tdir)) if os.path.isdir(tdir) else "MISSING")
    print("  v1.4.0 config present:", os.path.isfile(cfg))
    print("  loader has astral-skip:",
          "astral_skipped" in open(f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/data_loader.py").read())


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=3600,
)
def sync_v060():
    """Pull the latest training code (configs incl. v1.6.0-boundary-stress) + the v0.6.0-boundary-stress
    OVERLAY (manifest + boundary shard) from R2, container-side. The v0.5.0 base + the v0.6.0-a0 tokenizer
    are already on the volume from prior syncs; the overlay manifest references base shards at their /data
    v0.5.0 paths (re-rooted by the assembler), so only the overlay + the new config need pulling."""
    import shutil
    import subprocess

    print("Syncing v0.6.0-boundary-stress overlay + latest code from R2 (container-side)...")
    vol.reload()
    R = "--low-level-retries 30 --retries 8 --transfers 12 --checkers 24 --stats 30s --stats-log-level NOTICE"
    commands = [
        f"rclone copy :s3:{BUCKET}/corpus-python/src/ {VOL_MOUNT}/corpus-python/src/ {R}",
        f"rclone copy :s3:{BUCKET}/corpus/v0.6.0-boundary-stress/corpus-v0.6.0-boundary-stress/ "
        f"{VOL_MOUNT}/corpus/versioned/v0.6.0-boundary-stress/corpus-v0.6.0-boundary-stress/ {R}",
    ]
    for i, cmd in enumerate(commands):
        print(f"\n[{i+1}/{len(commands)}] {cmd[:90]}...")
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"STDERR: {result.stderr[:800]}")
            raise RuntimeError(f"rclone failed: {result.stderr[:200]}")
        if result.stdout:
            print(result.stdout[-300:])

    pyc = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/__pycache__"
    if os.path.isdir(pyc):
        shutil.rmtree(pyc)

    vol.commit()
    print("\nv0.6.0 overlay sync complete. Volume committed.")

    cdir = f"{VOL_MOUNT}/corpus/versioned/v0.6.0-boundary-stress/corpus-v0.6.0-boundary-stress"
    cfg = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/v1.6.0-boundary-stress.yaml"
    print("  v1.6.0 config present:", os.path.isfile(cfg))
    print("  overlay MANIFEST present:", os.path.isfile(f"{cdir}/MANIFEST.json"))
    print("  boundary shard present:", os.path.isfile(f"{cdir}/train/part-boundary-stress-train.parquet"))
    base0 = f"{VOL_MOUNT}/corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet"
    print("  sample re-rooted base shard on volume:", os.path.isfile(base0))


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=3600,
)
def sync_v061():
    """Pull the v0.6.1-boundary-stress OVERLAY (the BALANCED shard + manifest) + latest code (configs incl.
    v1.7.0-boundary-stress) from R2, container-side. The v0.5.0 base + the v0.6.0-a0 tokenizer persist on the
    volume; the overlay manifest re-roots base shards to their /data v0.5.0 paths, so only the overlay + the
    new config need pulling. Mirror of sync_v060 (night shift 2026-06-18 — the v1.7.0 corrective retrain)."""
    import shutil
    import subprocess

    print("Syncing v0.6.1-boundary-stress overlay + latest code from R2 (container-side)...")
    vol.reload()
    R = "--low-level-retries 30 --retries 8 --transfers 12 --checkers 24 --stats 30s --stats-log-level NOTICE"
    commands = [
        f"rclone copy :s3:{BUCKET}/corpus-python/src/ {VOL_MOUNT}/corpus-python/src/ {R}",
        f"rclone copy :s3:{BUCKET}/corpus/v0.6.1-boundary-stress/corpus-v0.6.1-boundary-stress/ "
        f"{VOL_MOUNT}/corpus/versioned/v0.6.1-boundary-stress/corpus-v0.6.1-boundary-stress/ {R}",
    ]
    for i, cmd in enumerate(commands):
        print(f"\n[{i+1}/{len(commands)}] {cmd[:90]}...")
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"STDERR: {result.stderr[:800]}")
            raise RuntimeError(f"rclone failed: {result.stderr[:200]}")
        if result.stdout:
            print(result.stdout[-300:])

    pyc = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/__pycache__"
    if os.path.isdir(pyc):
        shutil.rmtree(pyc)

    vol.commit()
    print("\nv0.6.1 overlay sync complete. Volume committed.")

    cdir = f"{VOL_MOUNT}/corpus/versioned/v0.6.1-boundary-stress/corpus-v0.6.1-boundary-stress"
    cfg = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/v1.7.0-boundary-stress.yaml"
    print("  v1.7.0 config present:", os.path.isfile(cfg))
    print("  overlay MANIFEST present:", os.path.isfile(f"{cdir}/MANIFEST.json"))
    print("  boundary shard present:", os.path.isfile(f"{cdir}/train/part-boundary-stress-train.parquet"))
    base0 = f"{VOL_MOUNT}/corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet"
    print("  sample re-rooted base shard on volume:", os.path.isfile(base0))


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=3600,
)
def sync_v080():
    """Pull the v0.8.0-fr-admin-split OVERLAY (the FR admin-split shard + manifest) + latest code (configs
    incl. v1.8.0-fr-admin-split) from R2, container-side. The v0.5.0 base + the v0.6.0-a0 tokenizer persist on
    the volume; the overlay manifest re-roots base shards to their /data v0.5.0 paths, so only the overlay +
    the new config need pulling. Mirror of sync_v061 (night shift 2026-06-19 — the surpass-v1.5.0 run)."""
    import shutil
    import subprocess

    print("Syncing v0.8.0-fr-admin-split overlay + latest code from R2 (container-side)...")
    vol.reload()
    R = "--low-level-retries 30 --retries 8 --transfers 12 --checkers 24 --stats 30s --stats-log-level NOTICE"
    commands = [
        f"rclone copy :s3:{BUCKET}/corpus-python/src/ {VOL_MOUNT}/corpus-python/src/ {R}",
        f"rclone copy :s3:{BUCKET}/corpus/v0.8.0-fr-admin-split/corpus-v0.8.0-fr-admin-split/ "
        f"{VOL_MOUNT}/corpus/versioned/v0.8.0-fr-admin-split/corpus-v0.8.0-fr-admin-split/ {R}",
    ]
    for i, cmd in enumerate(commands):
        print(f"\n[{i+1}/{len(commands)}] {cmd[:90]}...")
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"STDERR: {result.stderr[:800]}")
            raise RuntimeError(f"rclone failed: {result.stderr[:200]}")
        if result.stdout:
            print(result.stdout[-300:])

    pyc = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/__pycache__"
    if os.path.isdir(pyc):
        shutil.rmtree(pyc)

    vol.commit()
    print("\nv0.8.0 overlay sync complete. Volume committed.")

    cdir = f"{VOL_MOUNT}/corpus/versioned/v0.8.0-fr-admin-split/corpus-v0.8.0-fr-admin-split"
    cfg = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/v1.8.0-fr-admin-split.yaml"
    print("  v1.8.0 config present:", os.path.isfile(cfg))
    print("  overlay MANIFEST present:", os.path.isfile(f"{cdir}/MANIFEST.json"))
    print("  fr-admin-split shard present:", os.path.isfile(f"{cdir}/train/part-fr-admin-split-train.parquet"))
    base0 = f"{VOL_MOUNT}/corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet"
    print("  sample re-rooted base shard on volume:", os.path.isfile(base0))


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=3600,
)
def sync_v081():
    """Pull the v0.8.1-fr-admin-split OVERLAY (the country-bearing shard — the v1.8.0 fr.country fix +
    manifest) + latest code (configs incl. v1.8.1-fr-admin-split) from R2, container-side. Mirror of
    sync_v080 (night shift 2026-06-19 — the v1.8.1 fr.country refinement, ready to launch on operator GO)."""
    import shutil
    import subprocess

    print("Syncing v0.8.1-fr-admin-split overlay + latest code from R2 (container-side)...")
    vol.reload()
    R = "--low-level-retries 30 --retries 8 --transfers 12 --checkers 24 --stats 30s --stats-log-level NOTICE"
    commands = [
        f"rclone copy :s3:{BUCKET}/corpus-python/src/ {VOL_MOUNT}/corpus-python/src/ {R}",
        f"rclone copy :s3:{BUCKET}/corpus/v0.8.1-fr-admin-split/corpus-v0.8.1-fr-admin-split/ "
        f"{VOL_MOUNT}/corpus/versioned/v0.8.1-fr-admin-split/corpus-v0.8.1-fr-admin-split/ {R}",
    ]
    for i, cmd in enumerate(commands):
        print(f"\n[{i+1}/{len(commands)}] {cmd[:90]}...")
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"STDERR: {result.stderr[:800]}")
            raise RuntimeError(f"rclone failed: {result.stderr[:200]}")
        if result.stdout:
            print(result.stdout[-300:])

    pyc = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/__pycache__"
    if os.path.isdir(pyc):
        shutil.rmtree(pyc)

    vol.commit()
    print("\nv0.8.1 overlay sync complete. Volume committed.")

    cdir = f"{VOL_MOUNT}/corpus/versioned/v0.8.1-fr-admin-split/corpus-v0.8.1-fr-admin-split"
    cfg = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/v1.8.1-fr-admin-split.yaml"
    print("  v1.8.1 config present:", os.path.isfile(cfg))
    print("  overlay MANIFEST present:", os.path.isfile(f"{cdir}/MANIFEST.json"))
    print("  fr-admin-split shard present:", os.path.isfile(f"{cdir}/train/part-fr-admin-split-train.parquet"))
    base0 = f"{VOL_MOUNT}/corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet"
    print("  sample re-rooted base shard on volume:", os.path.isfile(base0))


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=3600,
)
def sync_v090():
    """Pull the v0.9.0-multilocale OVERLAY (#148 multi-locale parse-recall shard: 2.4M real Overture
    address rows across ~19 EU locales) + latest code (configs incl. v1.9.0-multilocale) from R2,
    container-side. Mirror of sync_v081. The base v0.5.0 + v0.8.0-fr-admin-split shards the overlay
    manifest references already persist on the volume from prior runs (verified below)."""
    import shutil
    import subprocess

    print("Syncing v0.9.0-multilocale overlay + latest code from R2 (container-side)...")
    vol.reload()
    R = "--low-level-retries 30 --retries 8 --transfers 12 --checkers 24 --stats 30s --stats-log-level NOTICE"
    commands = [
        f"rclone copy :s3:{BUCKET}/corpus-python/src/ {VOL_MOUNT}/corpus-python/src/ {R}",
        f"rclone copy :s3:{BUCKET}/corpus/v0.9.0-multilocale/corpus-v0.9.0-multilocale/ "
        f"{VOL_MOUNT}/corpus/versioned/v0.9.0-multilocale/corpus-v0.9.0-multilocale/ {R}",
    ]
    for i, cmd in enumerate(commands):
        print(f"\n[{i+1}/{len(commands)}] {cmd[:90]}...")
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"STDERR: {result.stderr[:800]}")
            raise RuntimeError(f"rclone failed: {result.stderr[:200]}")
        if result.stdout:
            print(result.stdout[-300:])

    pyc = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/__pycache__"
    if os.path.isdir(pyc):
        shutil.rmtree(pyc)

    vol.commit()
    print("\nv0.9.0 overlay sync complete. Volume committed.")

    cdir9 = f"{VOL_MOUNT}/corpus/versioned/v0.9.0-multilocale/corpus-v0.9.0-multilocale"
    cfg9 = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/v1.9.0-multilocale.yaml"
    print("  v1.9.0 config present:", os.path.isfile(cfg9))
    print("  overlay MANIFEST present:", os.path.isfile(f"{cdir9}/MANIFEST.json"))
    print("  overture shard present:", os.path.isfile(f"{cdir9}/train/part-overture-multilocale-train.parquet"))
    base09 = f"{VOL_MOUNT}/corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet"
    base89 = f"{VOL_MOUNT}/corpus/versioned/v0.8.0-fr-admin-split/corpus-v0.8.0-fr-admin-split/train/part-fr-admin-split-train.parquet"
    print("  base v0.5.0 shard on volume:", os.path.isfile(base09))
    print("  base v0.8.0 fr-admin-split shard on volume:", os.path.isfile(base89))
    print("  tokenizer v0.6.0-a0 on volume:", os.path.isfile(f"{VOL_MOUNT}/models/tokenizer/v0.6.0-a0/tokenizer.model"))


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=3600,
)
def sync_v091():
    """Pull the v0.9.1-multilocale OVERLAY (#148 v1.9.1 — the ORDER-OVERFIT FIX: the SAME 2.4M Overture
    rows as v0.9.0 but re-rendered in 3 natural orders (canonical/pc-first/city-first), so the model can
    no longer learn the "locality = last token-group" shortcut that sank v1.9.0). Mirror of sync_v090;
    base v0.5.0 + v0.8.0-fr-admin-split shards persist on the volume from prior runs (verified below)."""
    import shutil
    import subprocess

    print("Syncing v0.9.1-multilocale overlay + latest code from R2 (container-side)...")
    vol.reload()
    R = "--low-level-retries 30 --retries 8 --transfers 12 --checkers 24 --stats 30s --stats-log-level NOTICE"
    commands = [
        f"rclone copy :s3:{BUCKET}/corpus-python/src/ {VOL_MOUNT}/corpus-python/src/ {R}",
        f"rclone copy :s3:{BUCKET}/corpus/v0.9.1-multilocale/corpus-v0.9.1-multilocale/ "
        f"{VOL_MOUNT}/corpus/versioned/v0.9.1-multilocale/corpus-v0.9.1-multilocale/ {R}",
    ]
    for i, cmd in enumerate(commands):
        print(f"\n[{i+1}/{len(commands)}] {cmd[:90]}...")
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"STDERR: {result.stderr[:800]}")
            raise RuntimeError(f"rclone failed: {result.stderr[:200]}")
        if result.stdout:
            print(result.stdout[-300:])

    pyc = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/__pycache__"
    if os.path.isdir(pyc):
        shutil.rmtree(pyc)

    vol.commit()
    print("\nv0.9.1 overlay sync complete. Volume committed.")

    cdir = f"{VOL_MOUNT}/corpus/versioned/v0.9.1-multilocale/corpus-v0.9.1-multilocale"
    cfg = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/v1.9.1-multilocale-3order.yaml"
    print("  v1.9.1 config present:", os.path.isfile(cfg))
    print("  overlay MANIFEST present:", os.path.isfile(f"{cdir}/MANIFEST.json"))
    print("  3-order overture shard present:", os.path.isfile(f"{cdir}/train/part-overture-multilocale-3order-train.parquet"))
    base09 = f"{VOL_MOUNT}/corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet"
    base89 = f"{VOL_MOUNT}/corpus/versioned/v0.8.0-fr-admin-split/corpus-v0.8.0-fr-admin-split/train/part-fr-admin-split-train.parquet"
    print("  base v0.5.0 shard on volume:", os.path.isfile(base09))
    print("  base v0.8.0 fr-admin-split shard on volume:", os.path.isfile(base89))
    print("  tokenizer v0.6.0-a0 on volume:", os.path.isfile(f"{VOL_MOUNT}/models/tokenizer/v0.6.0-a0/tokenizer.model"))


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=3600,
)
def sync_v092():
    """Pull the v0.9.2-multilocale-au OVERLAY (#208 — ADD AUSTRALIA to v1.9.1's proven 3-order recipe).
    The gnaf G-NAF AU 3-order shard layered on v0.9.1-multilocale (overture 3-order + v0.5.0 base, both
    referenced verbatim by the manifest). Mirror of sync_v091; the base v0.5.0 + v0.9.1 overture shards
    persist on the volume from the v1.9.1 run (verified below — only the 16 MB gnaf overlay is new)."""
    import shutil
    import subprocess

    print("Syncing v0.9.2-multilocale-au overlay + latest code from R2 (container-side)...")
    vol.reload()
    R = "--low-level-retries 30 --retries 8 --transfers 12 --checkers 24 --stats 30s --stats-log-level NOTICE"
    commands = [
        f"rclone copy :s3:{BUCKET}/corpus-python/src/ {VOL_MOUNT}/corpus-python/src/ {R}",
        f"rclone copy :s3:{BUCKET}/corpus/v0.9.2-multilocale-au/corpus-v0.9.2-multilocale-au/ "
        f"{VOL_MOUNT}/corpus/versioned/v0.9.2-multilocale-au/corpus-v0.9.2-multilocale-au/ {R}",
    ]
    for i, cmd in enumerate(commands):
        print(f"\n[{i+1}/{len(commands)}] {cmd[:90]}...")
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"STDERR: {result.stderr[:800]}")
            raise RuntimeError(f"rclone failed: {result.stderr[:200]}")
        if result.stdout:
            print(result.stdout[-300:])

    pyc = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/__pycache__"
    if os.path.isdir(pyc):
        shutil.rmtree(pyc)

    vol.commit()
    print("\nv0.9.2 overlay sync complete. Volume committed.")

    cdir = f"{VOL_MOUNT}/corpus/versioned/v0.9.2-multilocale-au/corpus-v0.9.2-multilocale-au"
    cfg = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/v1.9.2-multilocale-au.yaml"
    print("  v1.9.2 config present:", os.path.isfile(cfg))
    print("  overlay MANIFEST present:", os.path.isfile(f"{cdir}/MANIFEST.json"))
    print("  gnaf AU 3-order shard present:", os.path.isfile(f"{cdir}/train/part-gnaf-au-train.parquet"))
    ovl91 = f"{VOL_MOUNT}/corpus/versioned/v0.9.1-multilocale/corpus-v0.9.1-multilocale/train/part-overture-multilocale-3order-train.parquet"
    base05 = f"{VOL_MOUNT}/corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet"
    print("  base v0.5.0 shard on volume (manifest-referenced):", os.path.isfile(base05))
    print("  v0.9.1 overture 3-order shard on volume (manifest-referenced):", os.path.isfile(ovl91))
    print("  tokenizer v0.6.0-a0 on volume:", os.path.isfile(f"{VOL_MOUNT}/models/tokenizer/v0.6.0-a0/tokenizer.model"))


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=3600,
)
def sync_v196_slavic():
    """#825 SHIP candidate. Pull the v0.9.6-slavic-anchor OVERLAY (= v0.9.3a3-anchor-absorption, v4.15.0's
    694 base shards referenced verbatim + already on the volume from the v4.15.0 run) + the one new
    oa-slavic street-level diacritic shard (89837 rows, CZ/PL/SK/SI real OpenAddresses). Mirror of
    sync_v092. The base v0.9.3a3 shards — incl synth-anchor-absorption, the #723 fix — persist on the
    volume; only the ~3.5 MB oa-slavic overlay is new. Train is `--resume none` (from scratch, 80k) so
    #723 is re-learned from the corpus (paint_mode=shaped + absorption shard both in the recipe), keeping
    the comparison to v4.15.0 a clean one-variable — only oa-slavic differs."""
    import shutil
    import subprocess

    print("Syncing v0.9.6-slavic-anchor overlay + latest code from R2 (container-side)...")
    vol.reload()
    R = "--low-level-retries 30 --retries 8 --transfers 12 --checkers 24 --stats 30s --stats-log-level NOTICE"
    commands = [
        f"rclone copy :s3:{BUCKET}/corpus-python/src/ {VOL_MOUNT}/corpus-python/src/ {R}",
        f"rclone copy :s3:{BUCKET}/corpus/v0.9.6-slavic-anchor/corpus-v0.9.6-slavic-anchor/ "
        f"{VOL_MOUNT}/corpus/versioned/v0.9.6-slavic-anchor/corpus-v0.9.6-slavic-anchor/ {R}",
    ]
    for i, cmd in enumerate(commands):
        print(f"\n[{i+1}/{len(commands)}] {cmd[:90]}...")
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"STDERR: {result.stderr[:800]}")
            raise RuntimeError(f"rclone failed: {result.stderr[:200]}")
        if result.stdout:
            print(result.stdout[-300:])

    pyc = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/__pycache__"
    if os.path.isdir(pyc):
        shutil.rmtree(pyc)

    vol.commit()
    print("\nv0.9.6-slavic-anchor overlay sync complete. Volume committed.")

    cdir = f"{VOL_MOUNT}/corpus/versioned/v0.9.6-slavic-anchor/corpus-v0.9.6-slavic-anchor"
    base = f"{VOL_MOUNT}/corpus/versioned/v0.9.3a3-anchor-absorption/corpus-v0.9.3a3-anchor-absorption"
    cfg = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/v1.9.6-slavic-anchor.yaml"
    print("  v1.9.6 config present:", os.path.isfile(cfg))
    print("  overlay MANIFEST present:", os.path.isfile(f"{cdir}/MANIFEST.json"))
    print("  oa-slavic shard present:", os.path.isfile(f"{cdir}/train/part-oa-slavic-diacritic-train.parquet"))
    print("  base v0.9.3a3 MANIFEST on volume (manifest-referenced):", os.path.isfile(f"{base}/MANIFEST.json"))
    print(
        "  synth-anchor-absorption shard on volume (#723 fix):",
        os.path.isfile(f"{base}/train/part-anchor-absorption-train.parquet"),
    )
    print("  tokenizer v0.6.0-a0 on volume:", os.path.isfile(f"{VOL_MOUNT}/models/tokenizer/v0.6.0-a0/tokenizer.model"))


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=1800,
)
def sync_v197_bsplice():
    """#825 B-splice fine-tune. Pulls the code+config + the SPLICED tokenizer (v0.6.0-bsplice = v0.6.0-a0's
    48000 pieces + 10,582 diacritic pieces) + the EXPANDED v4.15.0 checkpoint (token_embeddings 48000 ->
    58582, the new rows mean-initialized from their old-tokenizer constituents). The v0.9.6-slavic-anchor
    corpus + base shards persist on the volume from the v196 run — only the tokenizer (~1.3 MB) and the
    expanded checkpoint (~112 MB) are new. The fine-tune is init_from (fresh optimizer), resume=none."""
    import shutil
    import subprocess

    print("Syncing v1.9.7-bsplice code+config + spliced tokenizer + expanded ckpt from R2...")
    vol.reload()
    R = "--low-level-retries 30 --retries 8 --transfers 8 --checkers 16 --stats 30s --stats-log-level NOTICE"
    commands = [
        f"rclone copy :s3:{BUCKET}/corpus-python/src/ {VOL_MOUNT}/corpus-python/src/ {R}",
        f"rclone copy :s3:{BUCKET}/models/tokenizer/v0.6.0-bsplice/ {VOL_MOUNT}/models/tokenizer/v0.6.0-bsplice/ {R}",
        f"rclone copy :s3:{BUCKET}/models/bsplice-expanded/ {VOL_MOUNT}/models/bsplice-expanded/ {R}",
    ]
    for i, cmd in enumerate(commands):
        print(f"\n[{i+1}/{len(commands)}] {cmd[:90]}...")
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"STDERR: {result.stderr[:800]}")
            raise RuntimeError(f"rclone failed: {result.stderr[:200]}")
        if result.stdout:
            print(result.stdout[-300:])

    pyc = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/__pycache__"
    if os.path.isdir(pyc):
        shutil.rmtree(pyc)
    vol.commit()
    print("\nv1.9.7-bsplice sync complete. Volume committed.")

    cfg = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/v1.9.7-bsplice.yaml"
    tok = f"{VOL_MOUNT}/models/tokenizer/v0.6.0-bsplice/tokenizer.model"
    exp = f"{VOL_MOUNT}/models/bsplice-expanded/pytorch_model.bin"
    cdir = f"{VOL_MOUNT}/corpus/versioned/v0.9.6-slavic-anchor/corpus-v0.9.6-slavic-anchor"
    print("  v1.9.7 config present:", os.path.isfile(cfg))
    print("  spliced tokenizer present:", os.path.isfile(tok))
    print("  expanded checkpoint present:", os.path.isfile(exp))
    print("  expanded config present:", os.path.isfile(f"{VOL_MOUNT}/models/bsplice-expanded/config.json"))
    print("  v0.9.6 corpus MANIFEST on volume (reused):", os.path.isfile(f"{cdir}/MANIFEST.json"))


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=1800,
)
def sync_v193():
    """#220/#723 Probe A0 (anchor-absorption, anchor_paint_mode=shaped). Syncs ONLY the code+config —
    A0 reuses v192's corpus-v0.9.2-multilocale-au (already on the volume); the ONLY data change is the
    LOAD-TIME anchor_paint_mode=shaped in encode_row, so no corpus rebuild/sync. Then PRE-SEEDS v192's
    step-040000 into the v193 output dir so `--resume auto` continues from v192 (the absorption fine-tune
    GROWS v192's capability — RESUME, not init_from). The v193 architecture is identical to v192, so the
    optimizer/scheduler/weights resume cleanly; only the painted-anchor distribution differs."""
    import shutil
    import subprocess

    print("Syncing v1.9.3 code+config from R2 + pre-seeding v192 ckpt (container-side)...")
    vol.reload()
    R = "--low-level-retries 30 --retries 8 --transfers 12 --checkers 24 --stats 30s --stats-log-level NOTICE"
    cmd = f"rclone copy :s3:{BUCKET}/corpus-python/src/ {VOL_MOUNT}/corpus-python/src/ {R}"
    print(f"\n{cmd[:90]}...")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"STDERR: {result.stderr[:800]}")
        raise RuntimeError(f"rclone failed: {result.stderr[:200]}")
    if result.stdout:
        print(result.stdout[-300:])

    # Pre-seed v192 step-040000 -> the v193 output dir so `--resume auto` continues from v192.
    src = f"{VOL_MOUNT}/output-v192-multilocale-au-s42/checkpoints/step-040000"
    dst = f"{VOL_MOUNT}/output-v193-anchor-absorption-s42/checkpoints/step-040000"
    if not os.path.isdir(src):
        raise RuntimeError(f"v192 checkpoint missing at {src} — cannot resume")
    if os.path.isdir(dst):
        print(f"  v193 pre-seed already present at {dst} (skip copy)")
    else:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copytree(src, dst)
        print(f"  pre-seeded v192 step-040000 -> {dst}")

    pyc = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/__pycache__"
    if os.path.isdir(pyc):
        shutil.rmtree(pyc)

    vol.commit()
    print("\nv1.9.3 code+config sync + pre-seed complete. Volume committed.")

    cfg = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/v1.9.3-anchor-absorption.yaml"
    shapes = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/postcode_shapes.py"
    cdir = f"{VOL_MOUNT}/corpus/versioned/v0.9.2-multilocale-au/corpus-v0.9.2-multilocale-au"
    print("  v1.9.3 config present:", os.path.isfile(cfg))
    print("  postcode_shapes.py present (the WHERE-fix code):", os.path.isfile(shapes))
    print("  v192 corpus MANIFEST present (reused, no rebuild):", os.path.isfile(f"{cdir}/MANIFEST.json"))
    print("  v193 pre-seed ckpt files:", sorted(os.listdir(dst)) if os.path.isdir(dst) else "MISSING")
    print("  tokenizer v0.6.0-a0 on volume:", os.path.isfile(f"{VOL_MOUNT}/models/tokenizer/v0.6.0-a0/tokenizer.model"))


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=1800,
)
def sync_v193a1():
    """#220/#723 Probe A1 (anchor-absorption + the synth-anchor-absorption counter-aug shard). Unlike A0,
    A1 has a NEW corpus (the v0.9.3-anchor-absorption OVERLAY = v0.9.2-multilocale-au's 693 base shards
    VERBATIM + the 1 counter-aug shard), so this pulls that overlay (small — base shards persist on the
    volume, referenced by the re-rooted manifest) + the code+config, then pre-seeds v192 step-040000 into
    the v193a1 output dir for `--resume auto` (RESUME, not init_from). Heavy CASE-P (35%) to stop the A0
    default-flip; gate = SLICE-H recovered AND postcode guardrail held."""
    import shutil
    import subprocess

    print("Syncing v1.9.3a1 overlay corpus + code+config from R2 + pre-seeding v192 ckpt...")
    vol.reload()
    R = "--low-level-retries 30 --retries 8 --transfers 12 --checkers 24 --stats 30s --stats-log-level NOTICE"
    commands = [
        f"rclone copy :s3:{BUCKET}/corpus-python/src/ {VOL_MOUNT}/corpus-python/src/ {R}",
        f"rclone copy :s3:{BUCKET}/corpus/v0.9.3-anchor-absorption/corpus-v0.9.3-anchor-absorption/ "
        f"{VOL_MOUNT}/corpus/versioned/v0.9.3-anchor-absorption/corpus-v0.9.3-anchor-absorption/ {R}",
    ]
    for i, cmd in enumerate(commands):
        print(f"\n[{i+1}/{len(commands)}] {cmd[:90]}...")
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"STDERR: {result.stderr[:800]}")
            raise RuntimeError(f"rclone failed: {result.stderr[:200]}")
        if result.stdout:
            print(result.stdout[-300:])

    src = f"{VOL_MOUNT}/output-v192-multilocale-au-s42/checkpoints/step-040000"
    dst = f"{VOL_MOUNT}/output-v193a1-anchor-absorption-s42/checkpoints/step-040000"
    if not os.path.isdir(src):
        raise RuntimeError(f"v192 checkpoint missing at {src} — cannot resume")
    if os.path.isdir(dst):
        print(f"  v193a1 pre-seed already present (skip copy)")
    else:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copytree(src, dst)
        print(f"  pre-seeded v192 step-040000 -> {dst}")

    pyc = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/__pycache__"
    if os.path.isdir(pyc):
        shutil.rmtree(pyc)

    vol.commit()
    print("\nv1.9.3a1 sync + pre-seed complete. Volume committed.")

    cdir = f"{VOL_MOUNT}/corpus/versioned/v0.9.3-anchor-absorption/corpus-v0.9.3-anchor-absorption"
    cfg = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/v1.9.3a1-anchor-absorption.yaml"
    print("  v1.9.3a1 config present:", os.path.isfile(cfg))
    print("  overlay MANIFEST present:", os.path.isfile(f"{cdir}/MANIFEST.json"))
    print("  counter-aug shard present:", os.path.isfile(f"{cdir}/train/part-anchor-absorption-train.parquet"))
    # A re-rooted BASE shard must resolve on the volume (the v1.6.0 re-root gotcha — fail loud here, not at train).
    base05 = f"{VOL_MOUNT}/corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet"
    gnaf = f"{VOL_MOUNT}/corpus/versioned/v0.9.2-multilocale-au/corpus-v0.9.2-multilocale-au/train/part-gnaf-au-train.parquet"
    print("  base v0.5.0 shard on volume (manifest-referenced):", os.path.isfile(base05))
    print("  gnaf AU shard on volume (manifest-referenced):", os.path.isfile(gnaf))
    print("  v193a1 pre-seed ckpt files:", sorted(os.listdir(dst)) if os.path.isdir(dst) else "MISSING")


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=1800,
)
def sync_v193a2():
    """#220/#723 Probe A1 (anchor-absorption + the synth-anchor-absorption counter-aug shard). Unlike A0,
    A1 has a NEW corpus (the v0.9.3a2-anchor-absorption OVERLAY = v0.9.2-multilocale-au's 693 base shards
    VERBATIM + the 1 counter-aug shard), so this pulls that overlay (small — base shards persist on the
    volume, referenced by the re-rooted manifest) + the code+config, then pre-seeds v192 step-040000 into
    the v193a2 output dir for `--resume auto` (RESUME, not init_from). Heavy CASE-P (35%) to stop the A0
    default-flip; gate = SLICE-H recovered AND postcode guardrail held."""
    import shutil
    import subprocess

    print("Syncing v1.9.3a2 overlay corpus + code+config from R2 + pre-seeding v192 ckpt...")
    vol.reload()
    R = "--low-level-retries 30 --retries 8 --transfers 12 --checkers 24 --stats 30s --stats-log-level NOTICE"
    commands = [
        f"rclone copy :s3:{BUCKET}/corpus-python/src/ {VOL_MOUNT}/corpus-python/src/ {R}",
        f"rclone copy :s3:{BUCKET}/corpus/v0.9.3a2-anchor-absorption/corpus-v0.9.3a2-anchor-absorption/ "
        f"{VOL_MOUNT}/corpus/versioned/v0.9.3a2-anchor-absorption/corpus-v0.9.3a2-anchor-absorption/ {R}",
    ]
    for i, cmd in enumerate(commands):
        print(f"\n[{i+1}/{len(commands)}] {cmd[:90]}...")
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"STDERR: {result.stderr[:800]}")
            raise RuntimeError(f"rclone failed: {result.stderr[:200]}")
        if result.stdout:
            print(result.stdout[-300:])

    src = f"{VOL_MOUNT}/output-v192-multilocale-au-s42/checkpoints/step-040000"
    dst = f"{VOL_MOUNT}/output-v193a2-anchor-absorption-s42/checkpoints/step-040000"
    if not os.path.isdir(src):
        raise RuntimeError(f"v192 checkpoint missing at {src} — cannot resume")
    if os.path.isdir(dst):
        print(f"  v193a2 pre-seed already present (skip copy)")
    else:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copytree(src, dst)
        print(f"  pre-seeded v192 step-040000 -> {dst}")

    pyc = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/__pycache__"
    if os.path.isdir(pyc):
        shutil.rmtree(pyc)

    vol.commit()
    print("\nv1.9.3a2 sync + pre-seed complete. Volume committed.")

    cdir = f"{VOL_MOUNT}/corpus/versioned/v0.9.3a2-anchor-absorption/corpus-v0.9.3a2-anchor-absorption"
    cfg = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/v1.9.3a2-anchor-absorption.yaml"
    print("  v1.9.3a2 config present:", os.path.isfile(cfg))
    print("  overlay MANIFEST present:", os.path.isfile(f"{cdir}/MANIFEST.json"))
    print("  counter-aug shard present:", os.path.isfile(f"{cdir}/train/part-anchor-absorption-train.parquet"))
    # A re-rooted BASE shard must resolve on the volume (the v1.6.0 re-root gotcha — fail loud here, not at train).
    base05 = f"{VOL_MOUNT}/corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet"
    gnaf = f"{VOL_MOUNT}/corpus/versioned/v0.9.2-multilocale-au/corpus-v0.9.2-multilocale-au/train/part-gnaf-au-train.parquet"
    print("  base v0.5.0 shard on volume (manifest-referenced):", os.path.isfile(base05))
    print("  gnaf AU shard on volume (manifest-referenced):", os.path.isfile(gnaf))
    print("  v193a2 pre-seed ckpt files:", sorted(os.listdir(dst)) if os.path.isdir(dst) else "MISSING")


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=1800,
)
def sync_v193a3():
    """#220/#723 Probe A1 (anchor-absorption + the synth-anchor-absorption counter-aug shard). Unlike A0,
    A1 has a NEW corpus (the v0.9.3a3-anchor-absorption OVERLAY = v0.9.2-multilocale-au's 693 base shards
    VERBATIM + the 1 counter-aug shard), so this pulls that overlay (small — base shards persist on the
    volume, referenced by the re-rooted manifest) + the code+config, then pre-seeds v192 step-040000 into
    the v193a3 output dir for `--resume auto` (RESUME, not init_from). Heavy CASE-P (35%) to stop the A0
    default-flip; gate = SLICE-H recovered AND postcode guardrail held."""
    import shutil
    import subprocess

    print("Syncing v1.9.3a3 overlay corpus + code+config from R2 + pre-seeding v192 ckpt...")
    vol.reload()
    R = "--low-level-retries 30 --retries 8 --transfers 12 --checkers 24 --stats 30s --stats-log-level NOTICE"
    commands = [
        f"rclone copy :s3:{BUCKET}/corpus-python/src/ {VOL_MOUNT}/corpus-python/src/ {R}",
        f"rclone copy :s3:{BUCKET}/corpus/v0.9.3a3-anchor-absorption/corpus-v0.9.3a3-anchor-absorption/ "
        f"{VOL_MOUNT}/corpus/versioned/v0.9.3a3-anchor-absorption/corpus-v0.9.3a3-anchor-absorption/ {R}",
    ]
    for i, cmd in enumerate(commands):
        print(f"\n[{i+1}/{len(commands)}] {cmd[:90]}...")
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"STDERR: {result.stderr[:800]}")
            raise RuntimeError(f"rclone failed: {result.stderr[:200]}")
        if result.stdout:
            print(result.stdout[-300:])

    src = f"{VOL_MOUNT}/output-v192-multilocale-au-s42/checkpoints/step-040000"
    dst = f"{VOL_MOUNT}/output-v193a3-anchor-absorption-s42/checkpoints/step-040000"
    if not os.path.isdir(src):
        raise RuntimeError(f"v192 checkpoint missing at {src} — cannot resume")
    if os.path.isdir(dst):
        print(f"  v193a3 pre-seed already present (skip copy)")
    else:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copytree(src, dst)
        print(f"  pre-seeded v192 step-040000 -> {dst}")

    pyc = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/__pycache__"
    if os.path.isdir(pyc):
        shutil.rmtree(pyc)

    vol.commit()
    print("\nv1.9.3a3 sync + pre-seed complete. Volume committed.")

    cdir = f"{VOL_MOUNT}/corpus/versioned/v0.9.3a3-anchor-absorption/corpus-v0.9.3a3-anchor-absorption"
    cfg = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/v1.9.3a3-anchor-absorption.yaml"
    print("  v1.9.3a3 config present:", os.path.isfile(cfg))
    print("  overlay MANIFEST present:", os.path.isfile(f"{cdir}/MANIFEST.json"))
    print("  counter-aug shard present:", os.path.isfile(f"{cdir}/train/part-anchor-absorption-train.parquet"))
    # A re-rooted BASE shard must resolve on the volume (the v1.6.0 re-root gotcha — fail loud here, not at train).
    base05 = f"{VOL_MOUNT}/corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet"
    gnaf = f"{VOL_MOUNT}/corpus/versioned/v0.9.2-multilocale-au/corpus-v0.9.2-multilocale-au/train/part-gnaf-au-train.parquet"
    print("  base v0.5.0 shard on volume (manifest-referenced):", os.path.isfile(base05))
    print("  gnaf AU shard on volume (manifest-referenced):", os.path.isfile(gnaf))
    print("  v193a3 pre-seed ckpt files:", sorted(os.listdir(dst)) if os.path.isdir(dst) else "MISSING")


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=1800,
)
def sync_v094_fr_bare():
    """#251/#148 fr-bare-street probe. The v0.9.4 overlay = v0.9.3a3's 694 shards VERBATIM (re-rooted to
    /data) + the 1 fr-bare-street shard (BAN-sourced bare-no-postcode FR streets — the postcode-anchoring
    lever). Pulls that overlay (small; base shards persist on the volume, referenced by the re-rooted
    manifest) + code/config, then pre-seeds the v193a3 step-080000 ckpt into the v194 output dir for
    `--resume auto` (RESUME — continue growing the FR street→locality boundary, NOT init_from)."""
    import shutil
    import subprocess

    print("Syncing v0.9.4 fr-bare-street overlay + code+config from R2 + pre-seeding v193a3 step-080000...")
    vol.reload()
    R = "--low-level-retries 30 --retries 8 --transfers 12 --checkers 24 --stats 30s --stats-log-level NOTICE"
    commands = [
        f"rclone copy :s3:{BUCKET}/corpus-python/src/ {VOL_MOUNT}/corpus-python/src/ {R}",
        f"rclone copy :s3:{BUCKET}/corpus/v0.9.4-fr-bare-street/corpus-v0.9.4-fr-bare-street/ "
        f"{VOL_MOUNT}/corpus/versioned/v0.9.4-fr-bare-street/corpus-v0.9.4-fr-bare-street/ {R}",
    ]
    for i, cmd in enumerate(commands):
        print(f"\n[{i+1}/{len(commands)}] {cmd[:90]}...")
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"STDERR: {result.stderr[:800]}")
            raise RuntimeError(f"rclone failed: {result.stderr[:200]}")
        if result.stdout:
            print(result.stdout[-300:])

    src = f"{VOL_MOUNT}/output-v193a3-anchor-absorption-s42/checkpoints/step-080000"
    dst = f"{VOL_MOUNT}/output-v194-fr-bare-street-s42/checkpoints/step-080000"
    if not os.path.isdir(src):
        raise RuntimeError(f"v193a3 step-080000 checkpoint missing at {src} — cannot resume")
    if os.path.isdir(dst):
        print("  v194 pre-seed already present (skip copy)")
    else:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copytree(src, dst)
        print(f"  pre-seeded v193a3 step-080000 -> {dst}")

    pyc = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/__pycache__"
    if os.path.isdir(pyc):
        shutil.rmtree(pyc)

    vol.commit()
    print("\nv0.9.4 fr-bare-street sync + pre-seed complete. Volume committed.")

    cdir = f"{VOL_MOUNT}/corpus/versioned/v0.9.4-fr-bare-street/corpus-v0.9.4-fr-bare-street"
    cfg = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/v1.9.4-fr-bare-street.yaml"
    print("  v1.9.4 config present:", os.path.isfile(cfg))
    print("  overlay MANIFEST present:", os.path.isfile(f"{cdir}/MANIFEST.json"))
    print("  fr-bare-street shard present:", os.path.isfile(f"{cdir}/train/part-fr-bare-street-train.parquet"))
    base05 = f"{VOL_MOUNT}/corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-0001.parquet"
    print("  base v0.5.0 shard on volume (manifest-referenced):", os.path.isfile(base05))
    print("  v194 pre-seed ckpt files:", sorted(os.listdir(dst)) if os.path.isdir(dst) else "MISSING")


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=1800,
)
def sync_v095_case():
    """#261 surface-augmentation (case) probe. Pulls ONLY code+config from R2 — the v0.9.4 corpus + base
    shards persist on the volume from v194 (the case augmentation is a TRAINING-TIME transform; no new
    corpus). Copies the v194 step-092000 ckpt into a FRESH v195 output dir for `--resume auto` (RESUME —
    grow case-robustness from v194, NOT init_from), leaving the shipped v194 output dir untouched."""
    import shutil
    import subprocess

    print("Syncing code+config from R2 + pre-seeding v194 step-092000 into the v195 probe dir...")
    vol.reload()
    R = "--low-level-retries 30 --retries 8 --transfers 12 --checkers 24 --stats 30s --stats-log-level NOTICE"
    cmd = f"rclone copy :s3:{BUCKET}/corpus-python/src/ {VOL_MOUNT}/corpus-python/src/ {R}"
    print(f"\n{cmd[:90]}...")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"STDERR: {result.stderr[:800]}")
        raise RuntimeError(f"rclone failed: {result.stderr[:200]}")
    if result.stdout:
        print(result.stdout[-300:])

    src = f"{VOL_MOUNT}/output-v194-fr-bare-street-s42/checkpoints/step-092000"
    dst = f"{VOL_MOUNT}/output-v195-surface-aug-s42/checkpoints/step-092000"
    if not os.path.isdir(src):
        raise RuntimeError(f"v194 step-092000 checkpoint missing at {src} — cannot resume")
    if os.path.isdir(dst):
        print("  v195 pre-seed already present (skip copy)")
    else:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copytree(src, dst)
        print(f"  pre-seeded v194 step-092000 -> {dst}")

    pyc = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/__pycache__"
    if os.path.isdir(pyc):
        shutil.rmtree(pyc)

    vol.commit()
    print("\nv1.9.5 surface-aug sync + pre-seed complete. Volume committed.")

    cfg = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/v1.9.5-surface-aug.yaml"
    aug = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/augment.py"
    print("  v1.9.5 config present:", os.path.isfile(cfg))
    print("  augment.py has case_prob:", "case_prob" in open(aug).read() if os.path.isfile(aug) else "MISSING")
    print("  v195 pre-seed ckpt files:", sorted(os.listdir(dst)) if os.path.isdir(dst) else "MISSING")


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=1800,
)
def push_artifact_r2(volume_path: str, r2_subpath: str):
    """Push a volume artifact (e.g. an exported model.onnx) OUT to R2, container-side.

    The mirror of sync_v050: on this volume the container<->CLI views are fully divergent (CLI writes
    don't reach containers AND container writes — checkpoints, exported ONNX — don't reach the CLI,
    verified 2026-06-12), so `modal volume get` can't pull a container-written artifact. Route it
    through R2 instead: this copies `<volume_path>` to `:s3:mailwoman-assets/<r2_subpath>`, then you
    `rclone copy` it down locally. Rides R2's intermittent 501s with retries.

    Usage: modal run scripts/modal/train_remote.py::push_artifact_r2 \\
             --volume-path /data/output-v140-charoffset-s42/model.onnx \\
             --r2-subpath artifacts/v1.4.0-charoffset/model.onnx"""
    import subprocess

    vol.reload()
    if not os.path.exists(volume_path):
        raise RuntimeError(f"volume artifact not found: {volume_path}")
    dst = f":s3:{BUCKET}/{r2_subpath}"
    cmd = f"rclone copyto '{volume_path}' '{dst}' --low-level-retries 30 --retries 8 --stats-one-line"
    print(f"push: {volume_path} -> {dst}")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"STDERR: {result.stderr[:800]}")
        raise RuntimeError(f"rclone push failed: {result.stderr[:200]}")
    print(f"pushed OK. Pull locally with: rclone copyto :s3:{BUCKET}/{r2_subpath} ./<local>")


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

    # Import and run training
    from mailwoman_train.config import Config, _merge
    from mailwoman_train.train import train as run_train

    import yaml
    cfg = Config()
    _merge(cfg, yaml.safe_load(open(config_path)))

    # Verify the corpus the config actually points at exists on the volume (post-config so the version
    # isn't hardcoded). The data loader reads cfg.data.corpus_dir; fail loud here if it's missing.
    train_dir = os.path.join(cfg.data.corpus_dir, "train")
    if not os.path.isdir(train_dir):
        raise RuntimeError(
            f"Corpus not found at {train_dir} (cfg.data.corpus_dir={cfg.data.corpus_dir}). "
            "Stage it with `modal volume put` or run sync_corpus first."
        )
    shard_count = len([f for f in os.listdir(train_dir) if f.endswith(".parquet")])
    print(f"Corpus: {cfg.data.corpus_dir} ({shard_count} train shards)")

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


@app.function(volumes={VOL_MOUNT: vol}, image=training_image, timeout=120)
def debug_volume(config_name: str = "v1.4.0-charoffset.yaml"):
    """Diagnostic: what does a container actually see on the volume, before/after vol.reload()?
    Added 2026-06-12 to chase a 'Config not found' on a config that `modal volume ls/get` confirms
    is present. Run: modal run scripts/modal/train_remote.py::debug_volume"""
    import os

    cfgdir = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs"
    cpath = f"{cfgdir}/{config_name}"
    ctrain = f"{VOL_MOUNT}/corpus/versioned/v0.5.0/corpus-v0.5.0/train"

    def snapshot(label):
        print(f"\n[{label}]")
        print("  configs dir exists:", os.path.isdir(cfgdir))
        if os.path.isdir(cfgdir):
            print("  configs:", sorted(os.listdir(cfgdir)))
        print(f"  isfile({config_name}):", os.path.isfile(cpath))
        print("  v0.5.0 train dir exists:", os.path.isdir(ctrain),
              "shards:", len(os.listdir(ctrain)) if os.path.isdir(ctrain) else 0)

    import modal as _m
    print("modal client version:", getattr(_m, "__version__", "?"))
    for d in ["/data", "/data/corpus/versioned", "/data/models", "/data/models/tokenizer",
              "/data/output-v140-charoffset-s42", "/data/output-v140-charoffset-s42/checkpoints"]:
        print(f"  ls {d}:", sorted(os.listdir(d)) if os.path.isdir(d) else "MISSING")

    snapshot("pre-reload (mount as-started)")
    vol.reload()
    snapshot("post-reload")


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
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=1800,
)
def sync_nsplice():
    """#912 lever 4 — Nordic splice staging. Pulls the v0.7.0-nsplice tokenizer (v0.6.0-bsplice's
    58,582 pieces + 8,613 Nordic diacritic pieces from OA fi/se/no/dk/is; #900 overlap gate PASS,
    accepted set stamped in the report next to the local artifact) and refreshes the training code.
    The mean-init input is models/bsplice-expanded — the SHIPPED v5.1.0 fp32 (the pure mean-init
    artifact; the fine-tune washed, see tokenizer_splice.py's header) — already on the volume."""
    import shutil
    import subprocess

    print("Syncing nsplice tokenizer + code from R2...")
    vol.reload()
    R = "--low-level-retries 30 --retries 8 --transfers 8 --checkers 16"
    commands = [
        f"rclone copy :s3:{BUCKET}/corpus-python/src/ {VOL_MOUNT}/corpus-python/src/ {R}",
        f"rclone copy :s3:{BUCKET}/models/tokenizer/v0.7.0-nsplice/ {VOL_MOUNT}/models/tokenizer/v0.7.0-nsplice/ {R}",
        f"rclone copy :s3:{BUCKET}/models/tokenizer/v0.7.1-nsplice/ {VOL_MOUNT}/models/tokenizer/v0.7.1-nsplice/ {R}",
    ]
    for i, cmd in enumerate(commands):
        print(f"[{i+1}/{len(commands)}] {cmd[:90]}...")
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"rclone failed: {result.stderr[:300]}")
    pyc = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/__pycache__"
    if os.path.isdir(pyc):
        shutil.rmtree(pyc)
    vol.commit()
    print("  nsplice tokenizer present:", os.path.isfile(f"{VOL_MOUNT}/models/tokenizer/v0.7.0-nsplice/tokenizer.model"))
    print("  base ckpt present:", os.path.isfile(f"{VOL_MOUNT}/models/bsplice-expanded/pytorch_model.bin"))


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=1800,
)
def sync_v210():
    """#901 re-scoped: v2.1.0-boundary-family — the v0.10.0 overlay (v0.9.4 base VERBATIM + the
    three new family shards si/no/cz; fr-bare-street already in the base) + code/configs. The
    nsplice-v2-expanded init ckpt and the v0.7.1-nsplice tokenizer are already on the volume from
    the v5.2.0 staging chain."""
    import shutil
    import subprocess

    print("Syncing v0.10.0 overlay + code/configs from R2...")
    vol.reload()
    R = "--low-level-retries 30 --retries 8 --transfers 8 --checkers 16"
    commands = [
        f"rclone copy :s3:{BUCKET}/corpus-python/src/ {VOL_MOUNT}/corpus-python/src/ {R}",
        f"rclone copy :s3:{BUCKET}/corpus/v0.10.0-boundary-family/corpus-v0.10.0-boundary-family/ "
        f"{VOL_MOUNT}/corpus/versioned/v0.10.0-boundary-family/corpus-v0.10.0-boundary-family/ {R}",
    ]
    for i, cmd in enumerate(commands):
        print(f"[{i+1}/{len(commands)}] {cmd[:90]}...")
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"rclone failed: {result.stderr[:300]}")
    pyc = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/__pycache__"
    if os.path.isdir(pyc):
        shutil.rmtree(pyc)
    vol.commit()
    for check, path in [
        ("v2.1.0 config", f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/v2.1.0-boundary-family.yaml"),
        ("probe config", f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/v2.1.0-boundary-family-probe.yaml"),
        ("overlay MANIFEST", f"{VOL_MOUNT}/corpus/versioned/v0.10.0-boundary-family/corpus-v0.10.0-boundary-family/MANIFEST.json"),
        ("init ckpt", f"{VOL_MOUNT}/models/nsplice-v2-expanded/pytorch_model.bin"),
        ("tokenizer", f"{VOL_MOUNT}/models/tokenizer/v0.7.1-nsplice/tokenizer.model"),
    ]:
        print(f"  {check} present:", os.path.isfile(path))


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    timeout=1200,
)
def mean_init_nsplice():
    """#912 lever 4: expand the shipped bsplice-expanded checkpoint's embeddings to the nsplice
    vocab (FVT mean-init — same surgery that produced v5.1.0). Writes /data/models/nsplice-expanded."""
    import sys
    sys.path.insert(0, "/data/corpus-python/src")
    from pathlib import Path

    from mailwoman_train.tokenizer_splice import mean_init_embeddings

    vol.reload()
    old_v, new_v = mean_init_embeddings(
        Path(f"{VOL_MOUNT}/models/bsplice-expanded"),
        Path(f"{VOL_MOUNT}/models/tokenizer/v0.6.0-bsplice/tokenizer.model"),
        Path(f"{VOL_MOUNT}/models/tokenizer/v0.7.1-nsplice/tokenizer.model"),
        Path(f"{VOL_MOUNT}/models/nsplice-v2-expanded"),
    )
    vol.commit()
    print(f"mean-init done: {old_v} -> {new_v} rows; /data/models/nsplice-expanded committed")


@app.function(
    volumes={VOL_MOUNT: vol},
    image=training_image,
    timeout=600,
)
def export_onnx(
    output_dir: str = "",
    step: str = "",
    tokenizer_path: str = "",
    model_dir: str = "",
):
    """Export a checkpoint to ONNX.

    Parameters accepted via ``modal run scripts/modal/train_remote.py::export_onnx
    --output-dir=/data/output-v062 --step=20000``. Env-var fallbacks
    (MAILWOMAN_EXPORT_OUTPUT_DIR / MAILWOMAN_EXPORT_STEP / MAILWOMAN_EXPORT_TOKENIZER)
    are kept for back-compat with prior workflows; CLI params take precedence when set.

    ``--model-dir`` bypasses the ``{output_dir}/checkpoints/step-{step}`` layout and loads a FLAT
    ``from_pretrained`` dir directly (``pytorch_model.bin`` + ``config.json``), writing ``model.onnx``
    into that same dir. Used to export an ad-hoc checkpoint — e.g. the #825 B-splice expanded-but-not-
    fine-tuned model for the mean-init ablation — without restructuring it into the training layout.
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

    if model_dir:
        ck_dir = Path(model_dir)
        out_path = Path(f"{model_dir}/model.onnx")
    else:
        ck_dir = Path(f"{output_dir}/checkpoints/step-{step}")
        out_path = Path(f"{output_dir}/model.onnx")
    tokenizer = Tokenizer(Path(tokenizer_path))

    _orig_load = torch.load
    torch.load = lambda *a, **kw: _orig_load(*a, **{**kw, "map_location": "cpu"})
    model = MailwomanCoarseEncoder.from_pretrained(ck_dir)
    torch.load = _orig_load
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
