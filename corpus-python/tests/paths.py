"""Path helpers for tests.

- We start from this file.
- We walk up parent directories.
- We stop when we find a known marker.

Tests can live at different nesting levels, avoiding fragile "go up N folders" path math.
"""

from __future__ import annotations

from pathlib import Path


def _ancestor_holding(marker: str) -> Path:
    """Return the closest parent directory (or this directory) containing `marker`."""
    for candidate in Path(__file__).resolve().parents:
        if (candidate / marker).exists():
            return candidate
    raise RuntimeError(f"no ancestor of {__file__} holds {marker!r}")


#: Package root (`corpus-python/`).
#:
#: We identify it by finding `src/mailwoman_train`.
#: The project manifest lives at the repo root.
PACKAGE_ROOT = _ancestor_holding("src/mailwoman_train")

#: Repository root.
#:
#: We identify it by finding `package.json`.
#: This is safer than assuming `PACKAGE_ROOT.parent` forever.
REPO_ROOT = _ancestor_holding("package.json")

#: Main source directory and its configs directory.
SOURCE_ROOT = PACKAGE_ROOT / "src" / "mailwoman_train"
CONFIGS = SOURCE_ROOT / "configs"
