"""Stage 1 coarse label set + helpers.

Mirrors the JS-side ``COMPONENT_TAGS`` / ``BIO_LABELS`` in
``packages/core/core/types/component.ts`` but restricted to the coarse subset Stage 1
trains on. Any tag outside ``STAGE1_COARSE_TAGS`` is rewritten to ``O`` at data-load time
(see ``data_loader.collapse_to_stage1``).

Drift check: keep this list in sync with the JS schema. If a new coarse tag lands in
``component.ts``, add it here in the same commit.
"""

from __future__ import annotations

from typing import Final

# Coarse tags Stage 1 trains on. Order is stable across runs so label IDs are reproducible.
STAGE1_COARSE_TAGS: Final[tuple[str, ...]] = (
    "country",
    "region",
    "locality",
    "dependent_locality",
    "postcode",
    "subregion",
    "cedex",
)

# BIO label vocabulary: O + (B-/I- per coarse tag). 1 + 14 = 15 labels.
STAGE1_BIO_LABELS: Final[tuple[str, ...]] = (
    "O",
    *(prefix + tag for tag in STAGE1_COARSE_TAGS for prefix in ("B-", "I-")),
)

LABEL_TO_ID: Final[dict[str, int]] = {label: i for i, label in enumerate(STAGE1_BIO_LABELS)}
ID_TO_LABEL: Final[dict[int, str]] = {i: label for label, i in LABEL_TO_ID.items()}

# Labels that mean "ignore" in cross-entropy. The HF Trainer treats ``-100`` as the sentinel.
IGNORE_INDEX: Final[int] = -100


def collapse_label(bio_label: str) -> str:
    """Rewrite a fine-grained BIO label to its Stage 1 equivalent, or ``O``.

    ``B-house_number`` → ``O``; ``B-region`` → ``B-region``; unknown → ``O``.
    """
    if bio_label == "O":
        return "O"
    if "-" not in bio_label:
        return "O"
    prefix, tag = bio_label.split("-", 1)
    if tag not in STAGE1_COARSE_TAGS or prefix not in ("B", "I"):
        return "O"
    return bio_label


def coarse_components_present(components_keys: list[str]) -> bool:
    """True iff the row has ``country`` and at least one of (region, locality, postcode).

    Used to filter the training rows per Phase 2 §5.1.
    """
    keys = set(components_keys)
    if "country" not in keys:
        return False
    return bool(keys & {"region", "locality", "postcode"})
