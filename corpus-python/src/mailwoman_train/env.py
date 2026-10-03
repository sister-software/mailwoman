"""The typed environment. No other module in this package reads `os.environ`.

The counterpart of `packages/core/lib/env/schema.ts`, with the same split: `public()` exposes
non-secret operational configuration, `private()` exposes credentials. A package that reads its own
variable declares it here, beside the reader, so the set of variables this code depends on is one
list rather than a grep.

A default turns "not configured" into "configured to a path that exists on one machine", and the
failure then surfaces as an empty corpus rather than as a missing setting.
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

    On Linux, `env-paths` returns `/tmp/<user>/mailwoman`. `platformdirs.user_runtime_dir` returns
    `/run/user/<uid>/mailwoman`. This measurement explains why the function does not use the latter.
    The other three roots agree between the libraries. The temp roots differ. A TypeScript tool
    writing to one while Python reads the other finds no entry.

    `env-paths` joins the username on Linux and omits it on macOS. This function mirrors that behavior.
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
    cache_root: Path
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

    A shell exports a blank variable when an unset value is interpolated into an `env:` block.
    A configured empty string would pass an empty value to a path join.
    """
    value = os.environ.get(name)
    return value if value else None


def _require_data_root() -> Path:
    """The data root, or a raise naming the variable.

    This variable has no default. The TypeScript side falls back to the platform data directory.
    That fallback is a real location for a user install. This package is maintainer-only training
    code whose data root holds tens of gigabytes of corpus and
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
