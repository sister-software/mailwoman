"""Builds this package's file paths from the roots set in the environment.

This module mirrors `@mailwoman/core/data-root` and `@mailwoman/core/paths`. Choose a root by the
kind of file:

- `data_root_path` holds large downloaded data such as corpora, gazetteers and model artifacts.
- `cache_root_path` holds regenerable files.
- `temp_root_path` holds named intermediates that a person may inspect.
- `config_root_path` holds settings that a person edits.
- `package_path` and `repo_root_path` locate files that ship with the source.
"""

from __future__ import annotations

from pathlib import Path

from .env import public

_PACKAGE_ROOT = Path(__file__).resolve().parent


def data_root_path(*parts: str) -> Path:
    """Return a path under `$MAILWOMAN_DATA_ROOT`."""
    return public().data_root.joinpath(*parts)


def config_root_path(*parts: str) -> Path:
    """Return a path under `$MAILWOMAN_CONFIG_ROOT`."""
    return public().config_root.joinpath(*parts)


def cache_root_path(*parts: str) -> Path:
    """Return a path under `$MAILWOMAN_CACHE_ROOT`."""
    return public().cache_root.joinpath(*parts)


def temp_root_path(*parts: str) -> Path:
    """Return a path under `$MAILWOMAN_TEMP_ROOT` for a named intermediate file.

    Use `tempfile` for scratch files that no later step reads.
    """
    return public().temp_root.joinpath(*parts)


def resolve_data_root_default(supplied: str | None, *parts: str) -> str:
    """Return the supplied flag value, or the data-root path when the flag was omitted.

    Declare the argparse flag with `default=None` and call this after parsing. A data-root default in
    `default=` would read the environment at declaration time and raise even when the flag is passed.
    """
    if supplied:
        return supplied
    return str(data_root_path(*parts))


def package_path(*parts: str) -> Path:
    """Return a path inside this package, such as a run config under `configs/`.

    The path is anchored at the package directory, so it works from a checkout and an installed copy.
    """
    return _PACKAGE_ROOT.joinpath(*parts)


def repo_root_path(*parts: str) -> Path:
    """Return a path in the repository checkout.

    The root is the nearest parent directory that holds both `packages/` and `package.json`. This
    raises `RuntimeError` outside a checkout.
    """
    for candidate in _PACKAGE_ROOT.parents:
        if (candidate / "packages").is_dir() and (candidate / "package.json").is_file():
            return candidate.joinpath(*parts)
    raise RuntimeError(
        f"no repository root above {_PACKAGE_ROOT}: looked for a parent holding both packages/ and "
        "package.json. This path is only meaningful inside a checkout."
    )
