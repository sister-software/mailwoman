"""Every path this package builds starts here.

The counterpart of `@mailwoman/core/data-root` and `@mailwoman/core/paths`. A path assembled from a
string literal encodes one machine's layout; these functions read the roots the environment names,
so the same code answers correctly on a lab checkout, a Modal container and a fresh clone.

Pick the root by what the file IS, not by where it happens to sit today:

- `data_root_path` — corpus, gazetteer, model artifacts. Large, downloaded, not reproducible cheaply.
- `cache_root_path` — regenerable. Deleting it costs time, never work.
- `temp_root_path` — a named intermediate a human may want to inspect. For an unnamed scratch file
  that nothing reads afterwards, use `tempfile`, not this.
- `config_root_path` — settings a human edits.
- `package_path` / `repo_root_path` — files that travel with the source.
"""

from __future__ import annotations

from pathlib import Path

from .env import public

#: This package's own directory: `<repo>/corpus-python/src/mailwoman_train`.
_PACKAGE_ROOT = Path(__file__).resolve().parent


def data_root_path(*parts: str) -> Path:
    """A path under `$MAILWOMAN_DATA_ROOT`."""
    return public().data_root.joinpath(*parts)


def config_root_path(*parts: str) -> Path:
    """A path under `$MAILWOMAN_CONFIG_ROOT`."""
    return public().config_root.joinpath(*parts)


def cache_root_path(*parts: str) -> Path:
    """A path under `$MAILWOMAN_CACHE_ROOT`."""
    return public().cache_root.joinpath(*parts)


def temp_root_path(*parts: str) -> Path:
    """A path under `$MAILWOMAN_TEMP_ROOT`, for a named intermediate worth keeping.

    Not a replacement for `tempfile`. A scratch file nothing reads afterwards should clean itself
    up; this is for output a human goes looking for.
    """
    return public().temp_root.joinpath(*parts)


def resolve_data_root_default(supplied: str | None, *parts: str) -> str:
    """A caller's flag value, or the data-root path it defaults to — resolved only if needed.

    Argparse evaluates `default=` when the argument is DECLARED, so a data-root default written
    there reads the environment at import and raises for a caller who was going to pass the flag
    anyway. Declare `default=None` and call this after parsing: the environment is read only when
    the caller left the flag off, which is the only case where its value matters.
    """
    if supplied:
        return supplied
    return str(data_root_path(*parts))


def package_path(*parts: str) -> Path:
    """A file shipped inside this package, such as a run config under `configs/`.

    Anchored at the package root, so it names the same file from a source checkout and from an
    installed copy.
    """
    return _PACKAGE_ROOT.joinpath(*parts)


def repo_root_path(*parts: str) -> Path:
    """A file in the repository checkout.

    Found by walking up for a directory holding both `packages/` and `package.json`, not by
    counting parent hops: a hop count encodes the caller's depth and breaks silently when a module
    moves. RAISES when no parent qualifies, because the alternative is a relative path that
    resolves against whatever the working directory happens to be.
    """
    for candidate in _PACKAGE_ROOT.parents:
        if (candidate / "packages").is_dir() and (candidate / "package.json").is_file():
            return candidate.joinpath(*parts)
    raise RuntimeError(
        f"no repository root above {_PACKAGE_ROOT}: looked for a parent holding both packages/ and "
        "package.json. This path is only meaningful inside a checkout."
    )
