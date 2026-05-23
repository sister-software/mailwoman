"""Phrase-prior input-layer features for the v0.5.0 classifier.

Stage 2.7 of the v0.5.0 pipeline (the phrase grouper, Thread E) emits ``PhraseProposal``s
— coarse boundary candidates with a structural ``PhraseKind`` hypothesis. The classifier
(Stage 3, this codebase) conditions on those proposals so it can answer the simpler
"what type is this proposed span?" instead of jointly discovering boundaries and types.

This module defines:

- ``PHRASE_KINDS``: the 7-kind taxonomy mirrored from the TS contract
  (``core/pipeline/types.ts``'s ``PhraseKind`` union). The Python-side enum is a tuple
  in declaration order; the order MUST match the TS union — the i-th kind in this tuple
  is the same kind as the i-th branch of ``PhraseKind`` in TS, because that's the same
  index used to one-hot encode per-token features.

- ``PhraseFeatureEncoding``: per-token feature width + the slot layout. v0.5.0 first
  cut uses a fixed one-hot (BIE markers + kind one-hot), per the plan doc recommendation.
  Total width = ``len(_BIE) + len(PHRASE_KINDS) = 3 + 7 = 10``.

Why mirror the TS taxonomy here instead of importing? The classifier trains in Python
on parquet shards that don't carry the TS-side ``PhraseProposal`` value type. The corpus
build (forthcoming, alongside corpus-v0.4.0) is what produces per-token feature tensors;
its bridge to the TS-side phrase grouper lives there, not here. This file is just the
shared vocabulary.

Drift check: if a new ``PhraseKind`` branch lands in ``core/pipeline/types.ts`` (or vice
versa), append it to ``PHRASE_KINDS`` in the same commit and bump the model card's
``phrase_kind_vocab`` so downstream loaders can detect the version skew.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

# Mirror of the TS-side ``PhraseKind`` union (see core/pipeline/types.ts in Thread E).
# Order is the encoding contract; never reorder, only append.
PHRASE_KINDS: Final[tuple[str, ...]] = (
    "NUMERIC",
    "STREET_PHRASE",
    "LOCALITY_PHRASE",
    "REGION_ABBREVIATION",
    "POSTCODE",
    "VENUE_PHRASE",
    "HYPHENATED_COMPOUND",
)

PHRASE_KIND_TO_ID: Final[dict[str, int]] = {k: i for i, k in enumerate(PHRASE_KINDS)}

# Per-token BIE marker slots. A token covered by a phrase proposal is exactly one of:
# - start of the proposal span
# - interior of the proposal span (neither start nor end)
# - end of the proposal span
# Tokens not covered by any proposal carry zeros in every slot.
_BIE_SLOTS: Final[tuple[str, ...]] = ("phrase_start", "phrase_mid", "phrase_end")

PHRASE_BIE_DIM: Final[int] = len(_BIE_SLOTS)
PHRASE_KIND_DIM: Final[int] = len(PHRASE_KINDS)
PHRASE_FEATURE_DIM: Final[int] = PHRASE_BIE_DIM + PHRASE_KIND_DIM


@dataclass(frozen=True)
class PhraseFeatureEncoding:
    """The per-token feature width + slot layout.

    Slot ordering:

    - slots 0..2 (``PHRASE_BIE_DIM`` = 3): ``phrase_start`` / ``phrase_mid`` / ``phrase_end``
    - slots 3..3+K-1 (``PHRASE_KIND_DIM`` = 7): one-hot over ``PHRASE_KINDS``

    Tokens not covered by any phrase proposal: all-zero feature vector.
    Tokens covered by multiple overlapping proposals (the plan's "possibilities not
    constraints" cases like ``Saint Petersburg`` being both one ``LOCALITY_PHRASE`` and
    two ``LOCALITY_PHRASE``s): the encoder consumes ONE feature row per token, so the
    corpus build picks the highest-confidence proposal covering that token. Downstream
    Stage 5 reconcile (Thread D) re-introduces the multi-proposal ambiguity from the
    grouper's raw output.
    """

    bie_dim: int = PHRASE_BIE_DIM
    kind_dim: int = PHRASE_KIND_DIM

    @property
    def total_dim(self) -> int:
        return self.bie_dim + self.kind_dim


def phrase_kind_id(kind: str) -> int:
    """Look up a ``PhraseKind`` by name; raises ``KeyError`` on unknown kinds.

    Unknown kinds are a corpus-version skew (TS-side added a kind, Python-side didn't).
    Fail loudly here rather than silently mapping to a default — the resulting model
    weights would mis-encode the new kind invisibly.
    """
    return PHRASE_KIND_TO_ID[kind]


__all__ = [
    "PHRASE_KINDS",
    "PHRASE_KIND_TO_ID",
    "PHRASE_BIE_DIM",
    "PHRASE_KIND_DIM",
    "PHRASE_FEATURE_DIM",
    "PhraseFeatureEncoding",
    "phrase_kind_id",
]
