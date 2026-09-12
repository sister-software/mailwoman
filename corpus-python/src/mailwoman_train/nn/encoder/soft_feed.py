"""One soft-feed channel: how it is built, and how it reaches the token representations.

Five channels — the postcode anchor, the gazetteer, the country lexicon, the street type and the
locality surface — are the same shape and differ only in feature width. Both halves live here
because expressing that five times is how the sixth gets built slightly differently.

Pure functions over tensors and modules: neither reads the encoder. That is what lets the
construction order stay visible at the one place that decides it, `model.__init__`.
"""

from __future__ import annotations

import torch
from torch import nn


def soft_feed_channel(
    enabled: bool,
    feature_dim: int,
    hidden_size: int,
) -> tuple[nn.Linear | None, nn.Parameter | None]:
    """One soft-feed channel's projection and learned cue vector, or a pair of Nones.

    A disabled channel must construct nothing at all, not construct-and-discard. `_init_weights`
    re-initializes by walking `self.parameters()`, which yields parameters in registration order
    and draws from the global RNG for each, so an extra registered module shifts the initial
    weights of every parameter registered after it.
    """
    if not enabled:
        return None, None
    return nn.Linear(feature_dim, hidden_size, bias=True), nn.Parameter(torch.zeros(hidden_size))


def inject_soft_feed(
    hidden: torch.Tensor,
    *,
    name: str,
    flag: str,
    projection: nn.Linear | None,
    cue: nn.Parameter | None,
    features: torch.Tensor | None,
    confidence: torch.Tensor | None,
    feature_dim: int,
    scale: torch.Tensor | None = None,
) -> tuple[torch.Tensor, torch.Tensor | None]:
    """Add one soft-feed channel to the token representations.

    Every channel is the same additive form: `h_i + c_i · (W · features_i + cue)`. The confidence
    scaling is what keeps a channel continuous rather than a switch — a token with no clue has
    c=0 and contributes exactly nothing, so an encoder given no features computes what an encoder
    built without the channel computes.

    Absent features on an ENABLED channel are zeros, which is the well-defined "no clue anywhere"
    inference path. Features supplied for a DISABLED channel raise: that combination means the
    caller built the wrong encoder, and silently dropping the evidence they passed would train or
    serve a model that ignores half its input.

    Returns the updated representations and the projected vector, which the postcode anchor needs
    for its second, pooled injection.
    """
    if projection is None or cue is None:
        if features is not None:
            raise ValueError(
                f"{name}_features supplied but {flag}=False — rebuild the "
                f"encoder with {flag}=True or drop the {name} arguments"
            )
        return hidden, None

    bsz, seq = hidden.shape[0], hidden.shape[1]
    if features is None or confidence is None:
        features = torch.zeros(bsz, seq, feature_dim, dtype=hidden.dtype, device=hidden.device)
        confidence = torch.zeros(bsz, seq, dtype=hidden.dtype, device=hidden.device)
    elif features.shape != (bsz, seq, feature_dim):
        raise ValueError(f"{name}_features shape {tuple(features.shape)} != ({bsz}, {seq}, {feature_dim})")

    projected = features.to(hidden.dtype)
    if scale is not None:
        projected = projected * scale.to(hidden.dtype)
    vector = projection(projected) + cue
    return hidden + confidence.to(hidden.dtype).unsqueeze(-1) * vector, vector
