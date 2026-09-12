"""What a staged Korean corpus must contain before a run can read it.

The launcher stages files; this says whether what landed is usable. It lives here because the answer
is Korean knowledge — how many numbered parts the Juso build writes, that the board and the sigungu
centroids travel with it, that the permit register is a separate corpus — and a launcher that knew
any of it would be a launcher one country's release schedule could break.
"""

from __future__ import annotations

import os

#: The corpus built from the Juso road-name address register.
LABEL_CORPUS = "v8-kr-2026-09-08"
#: The noisy register corpus: building permits, a separate build with its own single part.
REGISTER_CORPUS = "v8-kr-registry-2026-09-08"
#: How many numbered train parts the label build writes.
TRAIN_PARTS = 8


def staged(versioned: str) -> dict[str, bool]:
    """Each Korean expectation of a staged corpus tree, keyed by what it means."""
    label = f"{versioned}/{LABEL_CORPUS}"
    return {
        "KR train parts": all(
            os.path.isfile(f"{label}/train/kr-part-{index:04d}.parquet") for index in range(TRAIN_PARTS)
        ),
        "KR board + centroids": os.path.isfile(f"{label}/kr-board.jsonl")
        and os.path.isfile(f"{label}/kr-sigungu-centroids.json"),
        "KR registry train part": os.path.isfile(f"{versioned}/{REGISTER_CORPUS}/train/kr-registry-0000.parquet"),
    }
