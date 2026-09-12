"""The typed environment. Nothing else in this package reads `os.environ`.

The counterpart of `packages/core/lib/env/schema.ts`, with the same split: `public()` carries
non-secret operational configuration, `private()` carries credentials. A package that reads its own
variable declares it here, beside the reader, so the set of variables this code depends on is one
list rather than a grep.

Why a module instead of scattered `os.environ.get` calls: the nine call sites this replaced each
read `MAILWOMAN_DATA_ROOT` with a hard-coded fallback to one developer's data directory. A default
turns "not configured" into "configured to a path that exists on one machine", and the failure then
surfaces as an empty corpus rather than as a missing setting.
"""

from __future__ import annotations

import getpass
import os
import tempfile
from dataclasses import dataclass
from functools import cache
from pathlib import Path

import platformdirs

#: The application name both language runtimes resolve their platform directories under.
APP_NAME = "mailwoman"


def _platform_temp_root() -> Path:
    """The temp root, matching what `env-paths` answers on this platform.

    MEASURED on Linux, and the reason this is not `platformdirs.user_runtime_dir`: `env-paths`
    answers `/tmp/<user>/mailwoman` while `user_runtime_dir` answers `/run/user/<uid>/mailwoman`.
    The other three roots agree between the two libraries; this one does not, and a TypeScript tool
    writing to one while a Python tool reads the other finds nothing.

    `env-paths` joins the username on Linux and omits it on macOS, which is mirrored here.
    """
    base = Path(tempfile.gettempdir())
    if os.name == "posix" and not _is_macos():
        return base / getpass.getuser() / APP_NAME
    return base / APP_NAME


def _is_macos() -> bool:
    import sys

    return sys.platform == "darwin"


@dataclass(frozen=True)
class PublicEnv:
    """Non-secret operational configuration. Never holds a credential."""

    #: Root for downloaded data and runtime artifacts. Required: there is no usable default.
    data_root: Path
    #: Configuration files. Platform default when unset, matching the TypeScript side.
    config_root: Path
    #: Reusable downloaded and generated caches. Platform default when unset.
    cache_root: Path
    #: Named temporary outputs and staging. Platform default when unset.
    temp_root: Path


@dataclass(frozen=True)
class PrivateEnv:
    """Credentials. Never log a value from here."""

    #: Used by the DeepSeek corpus generator. Absent for every other command.
    deepseek_api_key: str | None


class MissingEnvironmentError(RuntimeError):
    """A required variable is unset, or set to blank."""


def _blank_as_absent(name: str) -> str | None:
    """Read a variable, treating a present-but-empty value as unset.

    A blank variable is what a shell exports when an unset value is interpolated into an `env:`
    block, and reading it as configured is how an empty string reaches a path join.
    """
    value = os.environ.get(name)
    return value if value else None


def _require_data_root() -> Path:
    """The data root, or a raise naming the variable.

    This one has no default, where the TypeScript side falls back to the platform data directory.
    The asymmetry is deliberate: that fallback is a real location for a user install, and this
    package is maintainer-only training code whose data root holds tens of gigabytes of corpus and
    gazetteer. A platform cache directory is never where that lives, so defaulting to one would
    answer a wrong path confidently instead of saying what is unset.
    """
    value = _blank_as_absent("MAILWOMAN_DATA_ROOT")
    if value is None:
        raise MissingEnvironmentError(
            "MAILWOMAN_DATA_ROOT is unset. It must point at the directory holding the corpus, "
            "gazetteer and model artifacts. There is no default: this package reads tens of "
            "gigabytes, and no platform directory is the right guess."
        )
    return Path(value)


@cache
def public() -> PublicEnv:
    """The non-secret environment, read and validated once."""
    return PublicEnv(
        data_root=_require_data_root(),
        config_root=Path(_blank_as_absent("MAILWOMAN_CONFIG_ROOT") or platformdirs.user_config_dir(APP_NAME)),
        cache_root=Path(_blank_as_absent("MAILWOMAN_CACHE_ROOT") or platformdirs.user_cache_dir(APP_NAME)),
        temp_root=Path(_blank_as_absent("MAILWOMAN_TEMP_ROOT") or _platform_temp_root()),
    )


@cache
def private() -> PrivateEnv:
    """The credential environment, read once."""
    return PrivateEnv(deepseek_api_key=_blank_as_absent("DEEPSEEK_API_KEY"))


def reset_cache() -> None:
    """Drop the cached views so a test can change the environment and read it again."""
    public.cache_clear()
    private.cache_clear()
