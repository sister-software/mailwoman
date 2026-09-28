"""What a callback can see of a run in progress.

The loop owns this object and mutates the reading fields before each dispatch, so every callback
observing one moment sees the same numbers. That matters for `elapsed`: the console line and the
CSV row it accompanies carry one reading rather than two clock calls a few microseconds apart.

Callbacks read the object. The loop writes it. Assigning to a field would steer the run.
`protocols.TrainCallback` forbids that.
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

    #: The char path sets `vocab_size` to 2 because it reads no SentencePiece table.
    #: `build_model` uses the same dummy width. The checkpoint extras record it here.
    vocab_size: int = 2

    #: The step this PROCESS began at: 0 on a fresh run, the checkpoint's step on a resume.
    #:
    #: `elapsed` is time since this process started, so throughput is `(step - start_step) / elapsed`.
    #: Dividing the absolute step by it reported 103.70 steps/s on a run resumed at 35,000.
    #: That run's real rate was 5.42 steps/s. The reported figure fell each line as `elapsed` grew.
    #: A resumed run inherits steps but starts a new elapsed-time counter.
    start_step: int = 0

    #: Set by the loop before each dispatch.
    elapsed: float = 0.0
    train_loss: float = 0.0
    learning_rate: float = 0.0

    #: Filled in by the eval dispatch so a callback can read the raw metrics the loop measured.
    val: dict[str, float] = field(default_factory=dict)
