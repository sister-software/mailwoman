"""Every value the launcher reads from the environment, read once, each with one documented default.

No other module in `launch/` reads `os.environ` or holds a bucket, volume, app, mount or GPU type literal. This is
the launcher's counterpart of `mailwoman_train/env.py`. That module cannot serve here, because Modal
imports `launch/` inside a container before the training package is on `sys.path`, so this file
imports only the standard library.

The `.env` file is found the way `packages/core/lib/env/env-file.ts` finds it: a `.env` in the working
directory wins, otherwise the main checkout's, located through a worktree's `.git` pointer and its
`commondir` file. No `git` subprocess runs. A key already in `os.environ` overrides the file.

The container has no `.env`. `container_env()` returns the non-secret settings, and `app.py` bakes them
into the image with `Image.env`. The container then reads the same values the local process used to define
the app. Credentials never travel that way: they go through a Modal secret.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from functools import cache
from pathlib import Path

_GIT_DIRECTORY_LINE = re.compile(r"^gitdir:[\t ]*(.+?)[\t ]*$", re.MULTILINE)


def _main_checkout_of(directory: Path) -> Path | None:
    """The main checkout of the worktree rooted at ``directory``, or ``None`` when it is not a worktree root."""
    pointer = directory / ".git"
    if not pointer.is_file():
        return None
    match = _GIT_DIRECTORY_LINE.search(pointer.read_text())
    if match is None:
        return None
    git_directory = (directory / match.group(1)).resolve()
    common = git_directory / "commondir"
    if not common.is_file():
        return None
    return (git_directory / common.read_text().strip()).resolve().parent


def _repository_root() -> Path:
    """The checkout this file belongs to: `corpus-python/launch/settings.py` sits two levels below it."""
    return Path(__file__).resolve().parents[2]


def resolve_env_file(working_directory: Path | None = None) -> Path | None:
    """The `.env` this process reads, or ``None`` when there is none.

    The working directory's own file wins, then the repository root's, then the main checkout's when the
    repository root is a worktree.
    """
    candidates = [working_directory or Path.cwd(), _repository_root()]
    for directory in candidates:
        local = directory / ".env"
        if local.is_file():
            return local
    for directory in candidates:
        main = _main_checkout_of(directory)
        if main is not None and (main / ".env").is_file():
            return main / ".env"
    return None


def parse_env_file(text: str) -> dict[str, str]:
    """Parse `KEY=value` lines, skipping blanks and comments and stripping one pair of matching quotes."""
    values: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


@cache
def _file_values() -> dict[str, str]:
    path = resolve_env_file()
    return parse_env_file(path.read_text()) if path is not None else {}


def read(name: str, default: str | None = None) -> str | None:
    """One variable: the environment first, then `.env`, then ``default``. A blank value counts as unset."""
    value = os.environ.get(name) or _file_values().get(name)
    return value if value else default


def read_keys(names: tuple[str, ...]) -> dict[str, str]:
    """The listed variables that are set, from the environment or `.env`."""
    return {name: value for name in names if (value := read(name)) is not None}


@dataclass(frozen=True)
class LaunchSettings:
    """The non-secret launch configuration. Every field is copied into the container's environment."""

    #: `MAILWOMAN_MODAL_APP`. The Modal app every launcher function registers on.
    app_name: str
    #: `MAILWOMAN_MODAL_VOLUME`. The training volume.
    volume_name: str
    #: `MAILWOMAN_VOLUME_MOUNT`. Where the volume mounts in a container. Configs state paths under it.
    volume_mount: str
    #: `MAILWOMAN_R2_BUCKET`. The R2 bucket rclone stages from.
    bucket: str
    #: `MAILWOMAN_MODAL_TRAIN_GPU`. The default training GPU; `--gpu` overrides it per launch.
    train_gpu: str
    #: `MAILWOMAN_MODAL_GRADE_GPU`. The GPU of the diagnostic fine-tune in `grade.py`.
    grade_gpu: str
    #: `MAILWOMAN_MODAL_EVAL_GPU`. The GPU of the inference-only grading functions.
    eval_gpu: str
    #: `MAILWOMAN_MODAL_TRAIN_RETRIES`. Attempts Modal makes after a failed or preempted training attempt.
    train_retries: int
    #: `MAILWOMAN_MODAL_R2_SECRET`. The named Modal secret holding the `RCLONE_S3_*` keys. Unset means the
    #: `.env` fallback builds the secret from the local file.
    r2_secret_name: str | None
    #: `MAILWOMAN_MODAL_HF_SECRET`. The named Modal secret holding `HF_TOKEN`. Unset means the `.env` fallback.
    hf_secret_name: str | None
    #: `MAILWOMAN_DATA_ROOT`. The local data root, read only by the local-mount staging path.
    data_root: str | None
    #: `MAILWOMAN_STAGE_LOCAL_CORPORA=1`. Mount local corpora into `stage_v8cjk_regs`'s image. Off by default,
    #: because Modal uploads an image's local directories on every `modal run` of the app, whichever
    #: function the run calls.
    stage_local_corpora: bool

    @property
    def sha256_cache(self) -> str:
        """The volume sidecar that caches per-file sha256 results by path, size and mtime."""
        return f"{self.volume_mount}/audits/sha256-cache.json"


@cache
def settings() -> LaunchSettings:
    """The launch settings, read once."""
    return LaunchSettings(
        app_name=read("MAILWOMAN_MODAL_APP", "mailwoman-training") or "",
        volume_name=read("MAILWOMAN_MODAL_VOLUME", "mailwoman-training") or "",
        volume_mount=read("MAILWOMAN_VOLUME_MOUNT", "/data") or "",
        bucket=read("MAILWOMAN_R2_BUCKET", "mailwoman-assets") or "",
        train_gpu=read("MAILWOMAN_MODAL_TRAIN_GPU", "A100-80GB") or "",
        grade_gpu=read("MAILWOMAN_MODAL_GRADE_GPU", "A100") or "",
        eval_gpu=read("MAILWOMAN_MODAL_EVAL_GPU", "A10G") or "",
        train_retries=int(read("MAILWOMAN_MODAL_TRAIN_RETRIES", "3") or "3"),
        r2_secret_name=read("MAILWOMAN_MODAL_R2_SECRET"),
        hf_secret_name=read("MAILWOMAN_MODAL_HF_SECRET"),
        data_root=read("MAILWOMAN_DATA_ROOT"),
        stage_local_corpora=read("MAILWOMAN_STAGE_LOCAL_CORPORA") == "1",
    )


def container_env() -> dict[str, str]:
    """The settings as environment variables for the image, so a container reads what the local process read.

    `MAILWOMAN_SHA256_CACHE` is read by `mailwoman_train.env`, which the loader consults before hashing a file.
    """
    current = settings()
    values = {
        "MAILWOMAN_MODAL_APP": current.app_name,
        "MAILWOMAN_MODAL_VOLUME": current.volume_name,
        "MAILWOMAN_VOLUME_MOUNT": current.volume_mount,
        "MAILWOMAN_R2_BUCKET": current.bucket,
        "MAILWOMAN_MODAL_TRAIN_GPU": current.train_gpu,
        "MAILWOMAN_MODAL_GRADE_GPU": current.grade_gpu,
        "MAILWOMAN_MODAL_EVAL_GPU": current.eval_gpu,
        "MAILWOMAN_MODAL_TRAIN_RETRIES": str(current.train_retries),
        "MAILWOMAN_SHA256_CACHE": current.sha256_cache,
    }
    # Only the secret names travel, so the container builds the same kind of secret object.
    if current.r2_secret_name:
        values["MAILWOMAN_MODAL_R2_SECRET"] = current.r2_secret_name
    if current.hf_secret_name:
        values["MAILWOMAN_MODAL_HF_SECRET"] = current.hf_secret_name
    return values


def reset_cache() -> None:
    """Drop the cached reads so a test can change the environment."""
    _file_values.cache_clear()
    settings.cache_clear()
