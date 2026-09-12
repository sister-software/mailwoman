"""Moving a collated batch onto the device, and reading the precision setting.

Shared by the supervised loop and the MLM pre-training loop. They previously lived in the trainer,
which made pre-training import the trainer while the trainer routed the MLM objective back to
pre-training — a cycle each side dodged with a deferred import.
"""

from __future__ import annotations

from typing import Any

import torch


def to_tensor_batch(batch: dict[str, Any], device: torch.device) -> dict[str, Any]:
    """Collated lists to device tensors, carrying every channel the loader emitted.

    A channel is present only when its lexicon is configured, so each is copied under its own
    guard. Dropping one here is silent: the encoder's forward zero-fills a missing channel, so the
    projection trains on zeros and the shipped weights carry an untrained channel. That happened to
    the locality-surface channel from v3.16.0 through v3.24.0 (#1349) — the loader painted the
    features, the collator emitted them, and this function dropped them. `test_train_channels`
    asserts key parity between the collator and this function so a channel cannot vanish again.
    """
    tb = {
        "input_ids": torch.tensor(batch["input_ids"], dtype=torch.long, device=device),
        "attention_mask": torch.tensor(batch["attention_mask"], dtype=torch.long, device=device),
        "labels": torch.tensor(batch["labels"], dtype=torch.long, device=device),
    }
    # PR3: per-row locale target for the self-conditioning aux head. Present whenever the data
    # loader emitted it (always, post-PR3); guarded so a pre-PR3 batch dict still works. The model
    # ignores it unless built with use_locale_conditioning.
    if "locale_ids" in batch:
        tb["locale_ids"] = torch.tensor(batch["locale_ids"], dtype=torch.long, device=device)
    if "anchor_features" in batch:
        tb["anchor_features"] = torch.tensor(batch["anchor_features"], dtype=torch.float32, device=device)
        tb["anchor_confidence"] = torch.tensor(batch["anchor_confidence"], dtype=torch.float32, device=device)
    if "gazetteer_features" in batch:
        tb["gazetteer_features"] = torch.tensor(batch["gazetteer_features"], dtype=torch.float32, device=device)
        tb["gazetteer_confidence"] = torch.tensor(batch["gazetteer_confidence"], dtype=torch.float32, device=device)
    if "country_features" in batch:
        tb["country_features"] = torch.tensor(batch["country_features"], dtype=torch.float32, device=device)
        tb["country_confidence"] = torch.tensor(batch["country_confidence"], dtype=torch.float32, device=device)
    if "street_type_features" in batch:
        tb["street_type_features"] = torch.tensor(batch["street_type_features"], dtype=torch.float32, device=device)
        tb["street_type_confidence"] = torch.tensor(batch["street_type_confidence"], dtype=torch.float32, device=device)
    if "locality_surface_features" in batch:
        tb["locality_surface_features"] = torch.tensor(
            batch["locality_surface_features"], dtype=torch.float32, device=device
        )
        tb["locality_surface_confidence"] = torch.tensor(
            batch["locality_surface_confidence"], dtype=torch.float32, device=device
        )
    # CharCNN input path (#825 / v8 CJK): (B, S, W) long char IDs — present iff data.char_mode is on.
    if "char_ids" in batch:
        tb["char_ids"] = torch.tensor(batch["char_ids"], dtype=torch.long, device=device)
    return tb


def precision_to_dtype(precision: str, device: torch.device) -> torch.dtype | None:
    """The autocast dtype for a precision setting, or None for full precision.

    fp16 answers None off CUDA: the CPU path has no fp16 kernels worth using, and asking for one
    there is a request full precision satisfies better than a failure would.
    """
    if precision == "fp16":
        return torch.float16 if device.type == "cuda" else None
    if precision == "bf16":
        return torch.bfloat16
    return None
