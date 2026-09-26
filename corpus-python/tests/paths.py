"""The roots a test reads from, found by walking up to the marker that defines each rather than counted, so a test may sit at any depth."""

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
