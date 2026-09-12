"""What a staged Taiwanese corpus must contain before a run can read it.

The launcher stages files; this says whether what landed is usable. It lives here for the same
reason Korea's does: the part count, the board and the district centroids are Taiwanese facts.
"""

from __future__ import annotations

import os

#: The corpus built from the Overture-TW rooftop extract.
LABEL_CORPUS = "v8-tw-2026-09-08"
#: The noisy register corpus: company registrations, a separate build with its own single part.
REGISTER_CORPUS = "v8-tw-registry-2026-09-08"
#: How many numbered train parts the label build writes.
TRAIN_PARTS = 8


def staged(versioned: str) -> dict[str, bool]:
    """Each Taiwanese expectation of a staged corpus tree, keyed by what it means."""
    label = f"{versioned}/{LABEL_CORPUS}"
    return {
        "TW train parts": all(
            os.path.isfile(f"{label}/train/tw-part-{index:04d}.parquet") for index in range(TRAIN_PARTS)
        ),
        "TW board + centroids": os.path.isfile(f"{label}/tw-board.jsonl")
        and os.path.isfile(f"{label}/tw-district-centroids.json"),
        "TW registry train part": os.path.isfile(f"{versioned}/{REGISTER_CORPUS}/train/tw-registry-0000.parquet"),
    }
