"""The Stage 1 coarse token-classification encoder.

One class across several modules, split by what each part owns rather than by size alone:

- `model.py` — `MailwomanCoarseEncoder` itself: construction, `forward`, and the predict paths.
- `state.py` — what construction establishes, declared once for every part that reads it.
- `heads.py` — building the output heads, and the weight initialization that follows them.
- `channels.py` — turning ids into representations, and adding each evidence channel to them.
- `losses.py` — composing the supervised loss and its auxiliary terms.
- `decode.py` — reading tag sequences out of the logits, the only paths that consult the CRF.
- `soft_feed.py` — one evidence channel, built and injected. Pure functions over tensors.
- `output.py` — what a forward pass returns, and the SDPA backend setting it needs.
- `build.py` — building an encoder from a `Config`, and counting what it holds.

CONSTRUCTION ORDER IS A CONTRACT. `_init_weights` walks `self.parameters()`, which yields in
registration order and draws from the global RNG for each, so moving a module's construction
changes the initial weights of everything registered after it and a from-scratch run stops
reproducing earlier ones. `tests/mailwoman_train/nn/test_encoder_split_parity.py` pins the logits,
the loss, the state-dict keys AND each parameter's initial checksum for exactly that reason.
"""

from __future__ import annotations

from .build import build_model, model_param_count
from .model import MailwomanCoarseEncoder
from .output import CoarseEncoderOutput, force_math_sdpa
from .soft_feed import inject_soft_feed, soft_feed_channel

__all__ = [
    "CoarseEncoderOutput",
    "MailwomanCoarseEncoder",
    "build_model",
    "force_math_sdpa",
    "inject_soft_feed",
    "model_param_count",
    "soft_feed_channel",
]
