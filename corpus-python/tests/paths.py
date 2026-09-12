"""The roots a test reads from, found rather than counted.

`Path(__file__).resolve().parents[2]` encodes the DEPTH of the file it is written in. Mirroring the
test tree onto the source tree moved eight tests one level down and every one of them silently
repointed — `corpus-python/tests/src/mailwoman_train/configs/...` instead of
`corpus-python/src/...`. Nothing in the path says which level was meant, so each failed as a missing
config file rather than as a wrong root, and a test that reads a directory rather than a file would
have failed at nothing at all.

Each root below walks up until it finds the marker that defines it, so a test may sit at any depth.
Import these instead of counting; the count is the defect.
"""

from __future__ import annotations

from pathlib import Path


def _ancestor_holding(marker: str) -> Path:
    """The nearest directory at or above this file that contains `marker`."""
    for candidate in Path(__file__).resolve().parents:
        if (candidate / marker).exists():
            return candidate
    raise RuntimeError(f"no ancestor of {__file__} holds {marker!r}")


#: `corpus-python/`, the directory holding the Python package's own manifest.
PACKAGE_ROOT = _ancestor_holding("pyproject.toml")

#: The repository root, which is the checkout's own manifest — NOT `PACKAGE_ROOT.parent`, which
#: would be right only while the Python package sits exactly one level down.
REPO_ROOT = _ancestor_holding("package.json")

#: The training package's source, and the recipe directory inside it.
SOURCE_ROOT = PACKAGE_ROOT / "src" / "mailwoman_train"
CONFIGS = SOURCE_ROOT / "configs"
