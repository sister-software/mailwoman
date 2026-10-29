"""Move a collated batch onto the device. Read the precision setting.

Shared by the supervised loop and the MLM pre-training loop. Both previously lived in the trainer.
That made pre-training import the trainer while the trainer routed the MLM objective back to
pre-training, creating a cycle each side dodged with a deferred import.
"""

from __future__ import annotations

from typing import Any

import mailwoman_mtf
import numpy as np
import torch

#: The id tensors every batch carries.
_REQUIRED_LONG_KEYS = ("input_ids", "attention_mask", "labels")

#: The per-row targets: the locale head's and the address-system head's, which a batch carries when the loader
#: emitted them.
_TARGET_KEYS = ("locale_ids", "address_system_ids")


def _tensor(value: Any, dtype: torch.dtype, device: torch.device, name: str) -> torch.Tensor:
    """One batch value as a tensor on `device`.

    An array from the row encoder is wrapped without a copy on the CPU and copied once to another device. Its dtype
    must already be the one the model reads, because a silent cast would hide an encoder that packed the wrong type.
    A list from the char path's `collate` is converted with `torch.tensor`.
    """
    if isinstance(value, np.ndarray):
        tensor = torch.from_numpy(value)
        if tensor.dtype != dtype:
            raise TypeError(f"batch value {name!r} is {tensor.dtype}, the model reads {dtype}")
        return tensor.to(device)
    return torch.tensor(value, dtype=dtype, device=device)


def to_tensor_batch(batch: dict[str, Any], device: torch.device) -> dict[str, Any]:
    """Batch values to device tensors, carrying every channel the loader emitted.

    A channel is present only when its lexicon is configured. Copy each channel under its own guard.
    A dropped channel makes the projection train on zeros, and the shipped weights would then include an
    untrained channel. `test_train_channels` checks key parity between the loader and this function.
    """
    tb = {name: _tensor(batch[name], torch.long, device, name) for name in _REQUIRED_LONG_KEYS}
    for name in _TARGET_KEYS:
        if name in batch:
            tb[name] = _tensor(batch[name], torch.long, device, name)
    for channel in mailwoman_mtf.CHANNEL_NAMES:
        for part in ("features", "confidence"):
            name = f"{channel}_{part}"
            if name in batch:
                tb[name] = _tensor(batch[name], torch.float32, device, name)
    # CharCNN input path (#825 / v8 CJK): (B, S, W) long char IDs — present iff data.char_mode is on.
    if "char_ids" in batch:
        tb["char_ids"] = _tensor(batch["char_ids"], torch.long, device, "char_ids")
    return tb


def precision_to_dtype(precision: str, device: torch.device) -> torch.dtype | None:
    """The autocast dtype for a precision setting, or None for full precision.

    fp16 answers `None` off CUDA because the CPU path has no usable fp16 kernels.
    Full precision satisfies that request better than a failure would.
    """
    if precision == "fp16":
        return torch.float16 if device.type == "cuda" else None
    if precision == "bf16":
        return torch.bfloat16
    return None
