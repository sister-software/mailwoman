"""Where a weights bundle gets written.

Both `package` and `smoke` write `neural-weights-<locale>/` into the workspace, so the search for
that directory lives beside them.
"""

from __future__ import annotations

from pathlib import Path


def find_packages_root() -> Path:
    """The workspace `packages/` directory, found by walking up for the repo root.

    Searches for a parent holding both `packages/` and `package.json` rather than counting hops. A
    hop count encodes this file's depth, so moving the module changes where the bundles get
    written — and the previous count was one too high, which sent the search past the repo root to
    a directory with no `packages/` at all.

    RAISES when no parent qualifies. The fallback was a relative `Path("packages")`, so a package
    build outside a checkout wrote `./packages/neural-weights-<locale>/` under the working
    directory and reported success.
    """
    here = Path(__file__).resolve()
    for candidate in here.parents:
        if (candidate / "packages").is_dir() and (candidate / "package.json").is_file():
            return candidate / "packages"
    raise RuntimeError(
        f"no repository root above {here}: looked for a parent holding both packages/ and "
        "package.json. Packaging weights needs the checkout it writes into."
    )
