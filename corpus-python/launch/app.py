"""The Modal app every launcher function attaches to: the image, the volume, and the secrets.

Import this, never redefine it. One `modal.App` object is what makes `modal run -m
launch.train_remote::<name>` able to find a function defined in any module of this package, so a
second app object here would produce functions nothing can launch.

Nothing in this module runs remotely. The secrets read the local checkout at deploy time and the
image pins the export/quant toolchain; both are evaluated at import, in the container as well as
locally, which is why each tolerates the container's empty environment rather than raising in it.
"""

from __future__ import annotations

import os
import subprocess

import modal

from .plan import BUCKET, VOL_MOUNT

app = modal.App("mailwoman-training")

vol = modal.Volume.from_name("mailwoman-training")

#: Where a run's artifacts land on the volume. The corpus and bucket paths live in `plan.py`.
OUTPUT_DIR = f"{VOL_MOUNT}/output"

__all__ = [
    "BUCKET",
    "OUTPUT_DIR",
    "VOL_MOUNT",
    "app",
    "hf_secret",
    "r2_secret",
    "training_image",
    "vol",
]

# Image with PyTorch (CUDA), rclone, sentencepiece, pyarrow, onnx
training_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("curl", "unzip")
    .run_commands(
        # Install rclone for R2 sync
        "curl -sSL https://rclone.org/install.sh | bash",
    )
    .pip_install(
        # --- PINNED export/quant toolchain (2026-06-09)
        # These five drive the ONNX graph that ships to browsers. They were UNPINNED (`>=`)
        # and drifted between v0.9.3 (Jun-6) and v0.9.7 (Jun-8): transformers→5.x and
        # onnx→1.21 started rejecting a dynamo-emitted value_info during int8 quant (see
        # mailwoman_train/quantize.py's value_info strip). Pinned to the exact set that
        # produced the v4.1.0 int8 artifact, VERIFIED graph-identical (opset 17, same
        # 28×DynamicQuantizeLinear/MatMulInteger, 0 reverse-slices) to the Safari-proven
        # v0.9.3 graph. INVARIANT: the int8 graph (opset + quant op scheme) must stay
        # within what the pinned `onnxruntime-web` native WebGPU EP runs on Metal (the
        # JSEP int8-dequant slice bug — the neural web runner uses onnxruntime-web/webgpu). A bump
        # here that raises the opset or changes the quant scheme is a Safari decision, not
        # a free upgrade — re-verify on a real iOS device (CI cannot exercise WebGPU).
        # Query the live image set with `modal run -m launch.train_remote::versions`.
        # onnx 1.21.0→1.22.0 (2026-07-12): security parity with pyproject (GHSA-hwpq-hmq9-wj77,
        # Dependabot #1057) — verify-toolchain requires the pins agree. VERIFIED same day by
        # re-export + re-quant of v241-fr-nsplice-ft step-12000 off this image: fp32 BYTE-
        # IDENTICAL to the 1.21.0-era export (md5 1c58b0a0) and int8 BYTE-IDENTICAL to the
        # shipped production artifact (md5 121162e6) — the bump provably does not touch the
        # graph. quantize.py's value_info strip stays (exercised in that run, harmless).
        "torch==2.12.0",
        "transformers==5.9.0",
        "onnx==1.22.0",
        "onnxruntime==1.26.0",
        "onnxscript==0.7.2",
        # --- non-graph deps
        # sentencepiece is PINNED, not floored (2026-08-01). It was `>=0.2.0` under a comment saying
        # unpinned floors are fine here — that assumption was false, because SP decides the token IDS
        # the model trains on. Measured: 0.2.1 and 0.2.2 disagree on a Viterbi tie-break for repeated
        # digit runs ("...555" segments ['55','5'] under 0.2.1 and ['5','55'] under 0.2.2), which fired
        # on 5/10,000 real corpus rows in the TS↔Python parity fixture. The shipped WASM runtime
        # (@mailwoman/sentencepiece-wasm) is built from 0.2.2 and reproduces 0.2.2 exactly, so training
        # pins to 0.2.2 to keep train and serve on one convention. A float here means the resolved
        # version depends on when Modal last rebuilt the image layer — i.e. train/serve agreement
        # decided by cache timing, which is not a thing anyone can debug after the fact.
        "sentencepiece==0.2.2",
        "pyarrow>=15",
        "pyyaml>=6",
        "numpy>=1.26,<3",
        "datasets>=2.19",
        "tqdm>=4.66",
        # Optional experiment tracking — streamed to a Hugging Face Space dashboard when
        # the run config sets train.trackio_enabled (best-effort, see trackio_logging.py).
        "trackio",
    )
    # Every launcher function lives in a module of this package, and Modal re-imports that module
    # inside the container to run it. Without the package the container raises ModuleNotFoundError
    # before any function body runs, which reads as a Modal fault rather than a missing file.
    .add_local_python_source("launch")
)


#: The RCLONE_S3_* keys rclone needs to reach R2. PROVIDER and the two credentials are what an empty
#: secret loses first: rclone then answers `s3 provider "" not known`, inside the container.
R2_KEYS = (
    "RCLONE_S3_PROVIDER",
    "RCLONE_S3_ACCESS_KEY_ID",
    "RCLONE_S3_SECRET_ACCESS_KEY",
    "RCLONE_S3_ENDPOINT",
    "RCLONE_S3_REGION",
    "RCLONE_S3_NO_CHECK_BUCKET",
)


def _env_file() -> str:
    """The checkout's untracked .env, resolved so a git WORKTREE finds the main checkout's copy.

    `.env` is untracked and lives only in the main checkout, so walking `..` from this file lands a
    worktree on a path that does not exist. `--git-common-dir` answers the main checkout's `.git` from
    inside any worktree, and its parent is the directory that holds `.env`. The plain relative path is
    the fallback for a tarball or a checkout git cannot answer for.
    """
    fallback = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".env"))
    try:
        common = subprocess.run(  # noqa: S603
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],  # noqa: S607
            cwd=os.path.dirname(__file__),
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return fallback
    return os.path.join(os.path.dirname(common), ".env") if common else fallback


def _read_env_keys(keys: tuple[str, ...]) -> dict[str, str]:
    """Read the named keys from the .env file, letting os.environ override what the file says."""
    env: dict[str, str] = {}
    env_file = _env_file()
    if os.path.isfile(env_file):
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, val = line.partition("=")
                    if key in keys:
                        env[key] = val
    for key in keys:
        if key in os.environ:
            env[key] = os.environ[key]
    return env


def _load_r2_env() -> dict[str, str]:
    """The R2 credentials, or a raise naming the file that did not supply them.

    An empty secret is NOT a usable state and must not be built quietly: the container starts, rclone
    reports `s3 provider "" not known`, and the operator reads a storage error for a missing file. So
    the absence is reported here, where the path is known, rather than a Modal app later.
    """
    env = _read_env_keys(R2_KEYS)
    missing = [key for key in R2_KEYS[:3] if not env.get(key)]
    if missing:
        raise RuntimeError(
            f"no R2 credentials: {_env_file()} supplied none of {missing} and neither did the "
            f"environment. rclone cannot reach the bucket without them."
        )
    return env


# The secret is built from the LOCAL checkout at deploy time, so the lookup runs only there. This
# module is imported inside every container too, where there is no .env and where only the functions
# that declare this secret are given the keys — so raising unconditionally crash-looped every
# function that does not use R2, the epoch audit included.
r2_secret = modal.Secret.from_dict(_load_r2_env() if modal.is_local() else {})


# HF token for Trackio's Hugging Face Space upload. Reads HF_TOKEN (or the
# HUGGING_FACE_HUB_TOKEN alias) from the local .env at deploy time, falling back to
# os.environ. Empty when unset — Trackio logging then degrades to CSV-only (the upload
# 401s and trackio_logging.py swallows it), so a token is only needed to push the
# dashboard to a Space.
def _load_hf_env() -> dict[str, str]:
    """The HF token, or nothing. Absence is tolerated here and refused in `_load_r2_env` — a run
    without R2 cannot read its corpus, while a run without this token still trains and logs to CSV.
    """
    return _read_env_keys(("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"))


hf_secret = modal.Secret.from_dict(_load_hf_env() if modal.is_local() else {})
