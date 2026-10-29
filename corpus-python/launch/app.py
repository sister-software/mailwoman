"""The Modal app every launcher function attaches to. It provides the image, volume and secrets.

Import this, never redefine it. One `modal.App` object is what makes `modal run -m
launch.train_remote::<name>` able to find a function defined in any module of this package, so a
second app object here would produce functions that no launcher can call.

Every name, mount and GPU comes from `launch/settings.py`. This module imports without error when
credentials are absent: a function that needs R2 calls `require_r2_env()` at its start, so `versions`,
`debug_volume` and `run_tests` run without R2 credentials.
"""

from __future__ import annotations

import os

import modal

from .plan import BUCKET, VOL_MOUNT
from .settings import container_env, read_keys, repository_root, resolve_env_file, settings

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
    "trainer_cpu_image",
    "trainer_cuda_image",
    "trainer_image",
    "training_image",
    "vol",
]

#: The rclone release the image installs, and the sha256 of its linux-amd64 zip from the release's
#: `SHA256SUMS`. The install script this replaced fetched whatever release was current at build time.
RCLONE_VERSION = "v1.71.2"
RCLONE_ZIP_SHA256 = "ab9fa5877cee91c64fdfd61a27028a458cf618b39259e5c371dc2ec34a12e415"
_RCLONE_ZIP = f"rclone-{RCLONE_VERSION}-linux-amd64"

#: The Rust toolchain the image builds `mailwoman_mtf` with. It equals `packages/mtf/rust-toolchain.toml`'s channel,
#: which `verify_toolchain.py` checks.
RUST_TOOLCHAIN = "1.99.1"

#: The wheel builder. It satisfies `packages/mtf/crates/mtf-py/pyproject.toml`'s build requirement, which
#: `verify_toolchain.py` checks.
MATURIN_VERSION = "1.15.0"

#: Where the image copies `packages/mtf`. The extension builds there once per image, so a crate change rebuilds the
#: image while `corpus upload --code`, which carries only `corpus-python/src` to the volume, does not carry it.
_MTF_BUILD_DIR = "/build/mtf"

training_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("build-essential", "curl", "unzip")
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
        # `mailwoman_train.env` imports it for the platform data, config and cache roots, and every module that
        # resolves a path through `mailwoman_train.paths` imports `env`.
        "platformdirs>=4.3",
        # Optional experiment tracking — streamed to a Hugging Face Space dashboard when
        # the run config sets train.trackio_enabled (best-effort, see trackio_logging.py).
        # Pinned to the version `uv.lock` resolves, so an image rebuild cannot move the dashboard client.
        "trackio==0.42.0",
        f"maturin=={MATURIN_VERSION}",
    )
    # rustup verifies each toolchain component it downloads. The toolchain version is pinned here.
    .run_commands(
        "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | "
        f"sh -s -- -y --profile minimal --default-toolchain {RUST_TOOLCHAIN}",
    )
    .env({"PATH": "/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"})
    .add_local_dir(
        str(repository_root() / "packages" / "mtf"),
        remote_path=_MTF_BUILD_DIR,
        copy=True,
        # The wheel reads the crates and the workspace manifests only.
        ignore=["target", "node_modules", "out", "wasm", "lib", "tools", "test", "third-party", "*.md", "*.json"],
    )
    # The `py` profile in `pyproject.toml` builds with `panic = "unwind"`, so a Rust panic raises in Python.
    .run_commands(
        f"cd {_MTF_BUILD_DIR}/crates/mtf-py && maturin build --locked --out /build/wheels",
        "pip install /build/wheels/mailwoman_mtf-*.whl",
        f"rm -rf {_MTF_BUILD_DIR}/target",
        'python -c "import mailwoman_mtf"',
    )
    # The container reads the launch settings the local process used to define the app.
    .env(container_env())
    # Every launcher function lives in a module of this package. Modal re-imports that module inside
    # the container. Without the package, the import raises ModuleNotFoundError before the function
    # body runs. Modal reports that import failure as a Modal fault.
    .add_local_python_source("launch")
)

#: The libtorch release `tch` 0.26.0 links (`torch-sys`'s `TORCH_VERSION`), which `packages/trainer` builds against.
LIBTORCH_VERSION = "2.13.0"

#: The sha256 of each `libtorch-shared-with-deps-2.13.0+<variant>.zip` a trainer image downloads. The CPU archive's
#: digest is also CI's, in `.github/workflows/test.yml`. `cu130` is the CUDA line of the Python trainer's torch 2.12.0
#: wheel (`cuda-toolkit` 13.0 in `uv.lock`), so a Rust run against a Python control changes libtorch and not CUDA.
#: Modal's host driver serves CUDA 13 to an A100.
LIBTORCH_ARCHIVES: dict[str, str] = {
    "cpu": "edbf4cbed78433d803e90a65f1752e57783d164bce66c95c0872b2ab8f5c159e",
    "cu130": "945c5a3d946a28b387ad9dc9fddda7ba03e35fae1375b84ebff15df789436f82",
}

#: The CUDA build the GPU trainer image links.
LIBTORCH_CUDA_VARIANT = "cu130"

#: The CUDA libraries libtorch 2.13.0+cu130 loads. Its archive holds only the torch libraries, so these are the
#: `Requires-Dist` set of the `torch-2.13.0+cu130` cp312 manylinux wheel on download.pytorch.org, the builds a torch
#: 2.13.0 CUDA process loads. Against the Python trainer's `uv.lock` only `cuda-toolkit` differs (13.0.2 there).
CUDA_RUNTIME_WHEELS = (
    "cuda-toolkit[cublas,cudart,cufft,cufile,cupti,curand,cusolver,cusparse,nvjitlink,nvrtc,nvtx]==13.0.3",
    "nvidia-cudnn-cu13==9.20.0.48",
    "nvidia-cusparselt-cu13==0.8.1",
    "nvidia-nccl-cu13==2.29.7",
    "nvidia-nvshmem-cu13==3.4.5",
)

#: Where a trainer image holds its repository files. The binary reads its data files from `MAILWOMAN_REPO_ROOT`.
TRAINER_REPO_ROOT = "/repo"

#: The repository data files `DataFiles::in_repository` (`packages/trainer/crates/trainer-loop/src/config.rs`) reads,
#: relative to the repository root.
TRAINER_DATA_FILES = (
    "corpus-python/src/mailwoman_train/data/augment/postcode-layouts.json",
    "corpus-python/src/mailwoman_train/features/postcode-shapes.json",
    "corpus-python/src/mailwoman_train/data/postcode-syntax.json",
    "corpus-python/src/mailwoman_train/address_systems.json",
    "packages/neural/data/label-schema.v1.json",
)


def trainer_image(variant: str) -> modal.Image:
    """The image that runs the Rust `trainer` binary, linked against the libtorch archive ``variant`` names.

    The image downloads the archive and checks its pinned sha256, copies the trainer and sampler crates and the data
    files the binary reads, and builds `trainer-cli`. A change under `packages/trainer` or `packages/mtf` rebuilds it.
    Python stays only because a Modal function body is Python. The wrapper in `launch/train_rust.py` runs the binary.
    """
    root = repository_root()
    archive = f"libtorch-shared-with-deps-{LIBTORCH_VERSION}%2B{variant}.zip"
    crates_ignore = ["target", "node_modules", "out", "wasm", "lib", "tools", "test", "third-party", "*.md"]
    image = (
        modal.Image.debian_slim(python_version="3.12")
        .apt_install("build-essential", "curl", "unzip")
        .run_commands(
            f"curl -fsSL -o /tmp/libtorch.zip https://download.pytorch.org/libtorch/{variant}/{archive}",
            f"echo '{LIBTORCH_ARCHIVES[variant]}  /tmp/libtorch.zip' | sha256sum -c -",
            "unzip -q /tmp/libtorch.zip -d /opt",
            "rm /tmp/libtorch.zip",
        )
    )
    if variant != "cpu":
        # The wheels put each library under `site-packages/nvidia/.../lib`; the loader learns every such directory.
        image = image.pip_install(*CUDA_RUNTIME_WHEELS).run_commands(
            "python -c 'import site; print(site.getsitepackages()[0])' > /tmp/site",
            "find \"$(cat /tmp/site)/nvidia\" -name 'lib*.so*' -printf '%h\\n' | sort -u > /etc/ld.so.conf.d/nvidia.conf",
            "cat /etc/ld.so.conf.d/nvidia.conf && ldconfig",
        )
    image = (
        image.run_commands(
            "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | "
            f"sh -s -- -y --profile minimal --default-toolchain {RUST_TOOLCHAIN}",
        )
        .env(
            {
                "PATH": "/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "LIBTORCH": "/opt/libtorch",
                "LD_LIBRARY_PATH": "/opt/libtorch/lib",
                "MAILWOMAN_REPO_ROOT": TRAINER_REPO_ROOT,
            }
        )
        .add_local_dir(
            str(root / "packages" / "trainer"),
            remote_path=f"{TRAINER_REPO_ROOT}/packages/trainer",
            copy=True,
            ignore=["target", "*.md"],
        )
        # The trainer's path dependencies inherit `packages/mtf/Cargo.toml`'s workspace fields, so the workspace
        # manifest travels with the crates.
        .add_local_dir(
            str(root / "packages" / "mtf"),
            remote_path=f"{TRAINER_REPO_ROOT}/packages/mtf",
            copy=True,
            ignore=crates_ignore,
        )
    )
    for relative in TRAINER_DATA_FILES:
        image = image.add_local_file(str(root / relative), remote_path=f"{TRAINER_REPO_ROOT}/{relative}", copy=True)
    return (
        image.run_commands(
            f"cd {TRAINER_REPO_ROOT}/packages/trainer && cargo build --release --locked -p trainer-cli",
            f"install -m 0755 {TRAINER_REPO_ROOT}/packages/trainer/target/release/trainer /usr/local/bin/trainer",
            f"rm -rf {TRAINER_REPO_ROOT}/packages/trainer/target /root/.cargo/registry",
        )
        .run_commands(
            # Every shared object the binary links resolves, except the CUDA driver's `libcuda.so.1`, which a build
            # container lacks and Modal mounts into a GPU container at run time.
            "ldd /usr/local/bin/trainer | grep 'not found' || true",
            "! ldd /usr/local/bin/trainer | grep 'not found' | grep -v 'libcuda\\.so\\.1'",
            # The image's size, in the build log.
            "du -sxm / /opt/libtorch 2>/dev/null",
        )
        .env(container_env())
        .add_local_python_source("launch")
    )


#: The Rust trainer on CUDA libtorch, for training on a GPU.
trainer_cuda_image = trainer_image(LIBTORCH_CUDA_VARIANT)

#: The Rust trainer on CPU libtorch, for the lifecycle checks on a small CPU job.
trainer_cpu_image = trainer_image("cpu")


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
