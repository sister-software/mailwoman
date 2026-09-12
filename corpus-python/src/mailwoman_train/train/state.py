"""What a callback can see of a run in progress.

The loop owns this object and mutates the reading fields before each dispatch, so every callback
observing one moment sees the same numbers. That matters for `elapsed`: the console line and the
CSV row it accompanies carry one reading, not two clock calls a few microseconds apart.

Callbacks read; the loop writes. A callback that assigns to a field here is steering the run, which
is what `protocols.TrainCallback` forbids.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import torch

from ..config import Config
from ..tokenizer import Tokenizer


@dataclass
class TrainState:
    """The run, as the callbacks see it."""

    cfg: Config
    model: torch.nn.Module
    tokenizer: Tokenizer | None
    device: torch.device
    optimizer: torch.optim.Optimizer
    scheduler: Any
    output_dir: Path
    started: float

    #: `vocab_size` is 2 on the char path, which reads no SentencePiece table — the same dummy
    #: width `build_model` uses, carried here so the checkpoint's extras can state it.
    vocab_size: int = 2

    #: Set by the loop before each dispatch.
    elapsed: float = 0.0
    train_loss: float = 0.0
    learning_rate: float = 0.0

    #: Filled in by the eval dispatch so a callback can read the raw metrics the loop measured.
    val: dict[str, float] = field(default_factory=dict)
