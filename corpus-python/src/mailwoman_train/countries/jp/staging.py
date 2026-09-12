"""What a staged Japanese corpus must contain before a run can read it.

The launcher stages files; this says whether what landed is usable. Japan's base corpus is shared:
the kana build is the base the CJK overlay's MANIFEST points back at, so a run that stages only the
overlay still needs these parts already on the volume.
"""

from __future__ import annotations

import os

#: The kana-surface build, and the base the CJK overlay's MANIFEST re-roots onto.
KANA_CORPUS = "v8-jp-kana-2026-09-06"
#: The noisy register corpus: corporate numbers, a separate build with its own single part.
REGISTER_CORPUS = "v8-jp-registry-2026-09-08"
#: How many numbered train parts the kana build writes.
TRAIN_PARTS = 8


def staged(versioned: str) -> dict[str, bool]:
    """Each Japanese expectation of a staged corpus tree, keyed by what it means."""
    return {
        "JP kana base train parts": all(
            os.path.isfile(f"{versioned}/{KANA_CORPUS}/train/part-{index:04d}.parquet") for index in range(TRAIN_PARTS)
        ),
        "JP registry train part": os.path.isfile(f"{versioned}/{REGISTER_CORPUS}/train/jp-registry-0000.parquet"),
    }
