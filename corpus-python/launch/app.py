"""The Modal app every launcher function attaches to. It provides the image, volume and secrets.

Import this, never redefine it. One `modal.App` object is what makes `modal run -m
launch.train_remote::<name>` able to find a function defined in any module of this package, so a
second app object here would produce functions that no launcher can call.

Every name, mount and GPU comes from `launch/settings.py`. This module imports without error when
credentials are absent: a function that needs R2 calls `require_r2_env()` at its start, so `versions`,
`debug_volume`, `run_tests` and `export_onnx` run without R2 credentials.
"""

from __future__ import annotations

import os

import modal

from .plan import BUCKET, VOL_MOUNT
from .settings import container_env, read_keys, resolve_env_file, settings

app = modal.App(settings().app_name)

vol = modal.Volume.from_name(settings().volume_name)

#: Where a run without a `/data/...`-style `output_dir` lands on the volume. The corpus and bucket paths live in `plan.py`.
OUTPUT_DIR = f"{VOL_MOUNT}/output"

__all__ = [
    "BUCKET",
    "OUTPUT_DIR",
    "VOL_MOUNT",
    "app",
    "hf_secret",
    "r2_secret",
    "require_r2_env",
    "training_image",
    "vol",
]

#: The rclone release the image installs, and the sha256 of its linux-amd64 zip from the release's
#: `SHA256SUMS`. The install script this replaced fetched whatever release was current at build time.
RCLONE_VERSION = "v1.71.2"
RCLONE_ZIP_SHA256 = "ab9fa5877cee91c64fdfd61a27028a458cf618b39259e5c371dc2ec34a12e415"
_RCLONE_ZIP = f"rclone-{RCLONE_VERSION}-linux-amd64"

training_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("curl", "unzip")
    .run_commands(
        f"curl -fsSL -o /tmp/rclone.zip https://downloads.rclone.org/{RCLONE_VERSION}/{_RCLONE_ZIP}.zip",
        f"echo '{RCLONE_ZIP_SHA256}  /tmp/rclone.zip' | sha256sum -c -",
        "unzip -q /tmp/rclone.zip -d /tmp",
        f"install -m 0755 /tmp/{_RCLONE_ZIP}/rclone /usr/local/bin/rclone",
        f"rm -rf /tmp/rclone.zip /tmp/{_RCLONE_ZIP}",
    )
    .pip_install(
        # Pinned export/quant toolchain. These five drive the ONNX graph that ships to browsers.
        # The int8 graph (opset + quant op scheme) must stay within what the pinned
        # `onnxruntime-web` native WebGPU EP runs on Metal (the JSEP int8-dequant slicing bug), so a
        # bump that raises the opset or changes the quant scheme is a Safari decision rather than a
        # free upgrade — re-verify on a real iOS device (CI cannot exercise WebGPU).
        # `verify-toolchain` requires these pins agree with pyproject.
        # Query the live image set with `modal run -m launch.train_remote::versions`.
        "torch==2.12.0",
        "transformers==5.9.0",
        "onnx==1.22.0",
        "onnxruntime==1.30.0",
        "onnxscript==0.7.2",
        # SentencePiece determines the token IDs used in training. The shipped wasm runtime
        # (@mailwoman/sentencepiece-wasm) is built from 0.2.2. Training also pins 0.2.2 so train
        # and serve use one convention.
        "sentencepiece==0.2.2",
        "pyarrow>=15",
        "pyyaml>=6",
        "numpy>=1.26,<3",
        # The JSONL and CSV reader (imported as `spliterator`), which also decompresses zstd parts.
        # Floored because it only reads formats. It does not decide token IDs or graph structure.
        # The same floor as the root `pyproject.toml`.
        "sister-software-spliterator>=10.1.1",
        # The same floor as the `train` extra in the root `pyproject.toml`.
        "datasets>=5.0.1",
        "tqdm>=4.66",
        # `mailwoman_train.env` reads it for the platform data root. No module imports it until the
        # anchor painter reaches `features/postcode_shapes.py`, so its absence surfaces mid-training
        # rather than at startup.
        "platformdirs>=4.3",
        # Optional experiment tracking — streamed to a Hugging Face Space dashboard when
        # the run config sets train.trackio_enabled (best-effort, see trackio_logging.py).
        # Pinned to the version `uv.lock` resolves, so an image rebuild cannot move the dashboard client.
        "trackio==0.42.0",
    )
    # The container reads the launch settings the local process used to define the app.
    .env(container_env())
    # Every launcher function lives in a module of this package. Modal re-imports that module inside
    # the container. Without the package, the import raises ModuleNotFoundError before the function
    # body runs. Modal reports that import failure as a Modal fault.
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

#: The keys without which rclone cannot reach the bucket at all.
R2_REQUIRED_KEYS = R2_KEYS[:4]

HF_KEYS = ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN")


def _secret(name: str | None, keys: tuple[str, ...], required: tuple[str, ...]) -> modal.Secret:
    """A named Modal secret when one is configured, otherwise the `.env` fallback.

    The named form is the intended one: `Secret.from_name` checks ``required`` when the app starts and
    reads only Modal's stored copy. The fallback copies the local values into an ephemeral secret, and only in the
    local process, because the container has no `.env`. It never raises: a function that needs the keys
    calls `require_r2_env`, so a function that needs none still runs without them.
    """
    if name:
        return modal.Secret.from_name(name, required_keys=list(required))
    return modal.Secret.from_dict({**read_keys(keys)} if modal.is_local() else {})


r2_secret = _secret(settings().r2_secret_name, R2_KEYS, R2_REQUIRED_KEYS)
hf_secret = _secret(settings().hf_secret_name, HF_KEYS, ())


def require_r2_env() -> None:
    """Raise inside a container whose secret lacks the R2 credentials, naming where they should have come from."""
    missing = [key for key in R2_REQUIRED_KEYS if not os.environ.get(key)]
    if not missing:
        return
    source = (
        f"the Modal secret {settings().r2_secret_name!r}"
        if settings().r2_secret_name
        else f"the local .env ({resolve_env_file() or 'none found'}) through the fallback secret"
    )
    raise RuntimeError(f"no R2 credentials: {source} supplied none of {missing}. rclone cannot reach the bucket.")
