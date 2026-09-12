"""What a forward pass returns, and the one backend setting it needs to run at all."""

from __future__ import annotations

import torch


def force_math_sdpa() -> None:
    """Disable flash / mem-efficient SDPA; force math kernel.

    Required on gfx1103 (Radeon 780M). Safe no-op on other backends. Idempotent.
    """
    if hasattr(torch.backends, "cuda"):
        for attr, on in (
            ("enable_flash_sdp", False),
            ("enable_mem_efficient_sdp", False),
            ("enable_math_sdp", True),
        ):
            fn = getattr(torch.backends.cuda, attr, None)
            if callable(fn):
                fn(on)


class CoarseEncoderOutput:
    """HuggingFace-style ``.loss`` / ``.logits`` accessor object.

    Kept as a thin attribute holder (not a dataclass) so the encoder forward stays close
    to the bert-style call signature the trainer and exporter expect.
    """

    __slots__ = ("loss", "logits", "locale_logits", "span_scores")

    def __init__(
        self,
        logits: torch.Tensor,
        loss: torch.Tensor | None,
        locale_logits: torch.Tensor | None = None,
        span_scores: torch.Tensor | None = None,
    ) -> None:
        self.logits = logits
        self.loss = loss
        # #727 stage-2: (B, S, L, T) per-span type scores, or None without ``use_span_scorer``.
        self.span_scores = span_scores
        # PR3 self-conditioning: ``(batch, num_locales)`` locale posterior logits from the aux
        # head, or None when the encoder was built without ``use_locale_conditioning``.
        self.locale_logits = locale_logits
