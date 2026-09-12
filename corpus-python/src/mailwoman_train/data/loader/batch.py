"""Stacking encoded examples into the batch the trainer feeds the model.

A channel is present in the batch only when the examples carry it, decided from the FIRST example
because every example in a run comes from one config. An absent channel is omitted rather than
zero-filled, so the trainer's tensor conversion skips it and the model runs without it.
"""

from __future__ import annotations

import random
from collections.abc import Iterator
from typing import Any

from ...config import Config
from ...tokenizer import Tokenizer
from .encode import iter_encoded
from .example import EncodedExample


def collate(batch: list[EncodedExample]) -> dict[str, Any]:
    """Stack a list of ``EncodedExample`` into batched lists. Caller wraps in torch tensors."""
    out = {
        "input_ids": [ex.input_ids for ex in batch],
        "attention_mask": [ex.attention_mask for ex in batch],
        "labels": [ex.labels for ex in batch],
        "locale_ids": [ex.locale_id for ex in batch],
    }
    # Postcode-anchor channel (#239/#240): only present when every example carries anchor features
    # (i.e. an anchor lookup is configured). Absent → omitted, so the trainer's tensor-conversion
    # skips it and the model runs anchor-free (back-compat).
    if batch and batch[0].anchor_features is not None:
        out["anchor_features"] = [ex.anchor_features for ex in batch]
        out["anchor_confidence"] = [ex.anchor_confidence for ex in batch]
    # Gazetteer-anchor channel (#464): same presence contract as the postcode anchor.
    if batch and batch[0].gazetteer_features is not None:
        out["gazetteer_features"] = [ex.gazetteer_features for ex in batch]
        out["gazetteer_confidence"] = [ex.gazetteer_confidence for ex in batch]
    # Country-lexicon channel (#1104): same presence contract.
    if batch and batch[0].country_features is not None:
        out["country_features"] = [ex.country_features for ex in batch]
        out["country_confidence"] = [ex.country_confidence for ex in batch]
    # Street-type channel (P-A / Option A): same presence contract.
    if batch and batch[0].street_type_features is not None:
        out["street_type_features"] = [ex.street_type_features for ex in batch]
        out["street_type_confidence"] = [ex.street_type_confidence for ex in batch]
    # Locality-surface channel (v3.16.0): same presence contract.
    if batch and batch[0].locality_surface_features is not None:
        out["locality_surface_features"] = [ex.locality_surface_features for ex in batch]
        out["locality_surface_confidence"] = [ex.locality_surface_confidence for ex in batch]
    # CharCNN input path (#825 / v8 CJK): same presence contract — set iff char_mode != "off".
    if batch and batch[0].char_ids is not None:
        out["char_ids"] = [ex.char_ids for ex in batch]
    return out


def iter_batches(
    cfg: Config,
    tokenizer: Tokenizer | None,
    *,
    split: str,
    batch_size: int,
    seed: int = 0,
    row_limit: int | None = None,
) -> Iterator[dict[str, Any]]:
    """Yield collated batches indefinitely until the underlying iterator exhausts."""
    rng = random.Random(seed)
    buf: list[EncodedExample] = []
    for ex in iter_encoded(cfg.data, tokenizer, split=split, rng=rng, row_limit=row_limit):
        buf.append(ex)
        if len(buf) == batch_size:
            yield collate(buf)
            buf = []
    if buf:
        yield collate(buf)
