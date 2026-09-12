"""What a staged CJK overlay must contain before a run can read it.

Two overlays are staged under this head and they are not interchangeable: `staged_overlay` is the
JP + CN corpus the v8 CJK base trains on, `staged_registries` adds Korea, Taiwan and the three noisy
register corpora. Each asks the countries in it for their own expectations and adds what belongs to
the region: the overlay's manifest, its re-sealed character vocabulary, and the markers that say the
volume's copy of the training package is the one this recipe needs rather than a stale sync.

A launcher calls these by name from the volume's own copy of the package, so an import failure here
IS the report that the package did not land.
"""

from __future__ import annotations

import os

from ..jp import staging as jp_staging
from ..kr import staging as kr_staging
from ..tw import staging as tw_staging

#: The JP + CN overlay the v8 CJK base trains on.
OVERLAY_CORPUS = "v8-cjk-2026-09-05"
#: The JP + CN + KR + TW overlay with the three register corpora layered in (#2204).
REGISTRIES_CORPUS = "v8-cjk-regs-2026-09-08"


def _overlay_files(versioned: str, corpus: str) -> dict[str, bool]:
    """The three files every CJK overlay carries, whichever countries are in it."""
    overlay = f"{versioned}/{corpus}"
    return {
        "overlay manifest": os.path.isfile(f"{overlay}/MANIFEST.json"),
        "CN train part": os.path.isfile(f"{overlay}/train/cn-units-0000.parquet"),
        "CJK char vocab": os.path.isfile(f"{overlay}/char-vocab-cjk.json"),
    }


def _contains(path: str, marker: str) -> bool:
    """Whether a synced file holds a marker. A path check answers that the file arrived; this
    answers that the file that arrived is the one the recipe needs."""
    if not os.path.isfile(path):
        return False
    with open(path, encoding="utf-8") as handle:
        return marker in handle.read()


def staged_overlay(package: str, versioned: str) -> dict[str, bool]:
    """What the JP + CN overlay needs: its own files, plus the head the recipe decodes against."""
    return {
        **_overlay_files(versioned, OVERLAY_CORPUS),
        "v8-cjk-full runs bf16 like v8-jp-full": _contains(f"{package}/configs/v8-cjk-full.yaml", "precision: bf16"),
        # `score.py` holds RESOLVE_TAGS — the file that decides which two spans form the centroid key.
        "the scorer knows stage3-cjk": _contains(f"{package}/evaluation/jp_probe_board/score.py", '"stage3-cjk"'),
        "the stage3-cjk label set is present": _contains(f"{package}/labels.py", '"stage3-cjk"'),
    }


def staged_registries(package: str, versioned: str) -> dict[str, bool]:
    """What the registries overlay needs: each country's own expectations, plus the region's."""
    return {
        **jp_staging.staged(versioned),
        **kr_staging.staged(versioned),
        **tw_staging.staged(versioned),
        **_overlay_files(versioned, REGISTRIES_CORPUS),
        "v8-cjk-regs configs": all(
            os.path.isfile(f"{package}/configs/{name}.yaml") for name in ("v8-cjk-regs-probe", "v8-cjk-regs")
        ),
    }
