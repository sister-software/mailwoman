"""The transformer block the encoder stacks.

Hand-rolled rather than taken from `transformers`: the export path needs a graph whose ops the
onnxruntime-web WebGPU runtime accepts, and a library block brings structure the exporter has to
be argued out of.
"""

from __future__ import annotations

import torch
from torch import nn


class EncoderBlock(nn.Module):
    """One pre-norm transformer block."""

    def __init__(
        self,
        hidden_size: int,
        num_heads: int,
        ff_intermediate: int,
        dropout: float,
    ) -> None:
        super().__init__()
        self.ln1 = nn.LayerNorm(hidden_size)
        self.attn = nn.MultiheadAttention(
            embed_dim=hidden_size,
            num_heads=num_heads,
            dropout=dropout,
            batch_first=True,
            bias=True,
        )
        self.ln2 = nn.LayerNorm(hidden_size)
        self.ff = nn.Sequential(
            nn.Linear(hidden_size, ff_intermediate),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(ff_intermediate, hidden_size),
        )
        self.dropout = nn.Dropout(dropout)

    def forward(
        self,
        x: torch.Tensor,
        key_padding_mask: torch.Tensor | None,
    ) -> torch.Tensor:
        # Pre-norm attention.
        h = self.ln1(x)
        attn_out, _ = self.attn(
            h,
            h,
            h,
            key_padding_mask=key_padding_mask,
            need_weights=False,
        )
        x = x + self.dropout(attn_out)
        # Pre-norm FFN.
        h = self.ln2(x)
        x = x + self.dropout(self.ff(h))
        return x
