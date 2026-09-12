"""Per-token embedding composed from a token's characters.

The drop-in alternative to the SentencePiece token-ID lookup, and the input path the CJK models
train on.
"""

from __future__ import annotations

import torch
from torch import nn


class CharCNNEmbedding(nn.Module):
    """Per-token embedding computed from a token's CHARACTERS via a multi-width 1D CNN.

    A drop-in replacement for the SentencePiece token-ID lookup (``nn.Embedding``). The input is
    char IDs per token: ``(B, S, W)`` where ``S`` is the WORD/token count (whitespace tokens for
    space-delimited scripts, one char per token for CJK) and ``W`` is max chars per token. It
    produces ``(B, S, hidden)`` — the exact shape the transformer body already consumes, so nothing
    downstream (anchor/gazetteer/phrase channels, the blocks, CRF, classifier) changes.

    Why this fixes the diacritic problem the SentencePiece path can't: the tokenizer is now
    word-level, so "Čistá" is ONE token whose embedding is composed from its own characters — the
    subword vocab never gets to isolate the diacritic into its own O-tagged piece (the 3.3x Slavic
    fertility tax that broke span boundaries → wrong-city geocoding). The char vocab is small (the
    Unicode chars seen in training, a few thousand), so the embedding table is a fraction of a 48k SP
    vocab. Generalizes to any script — for CJK, one character is one token, no giant subword vocab.

    ONNX-clean: Embedding + Conv1d + ReLU + masked max-pool + Linear are all standard ops the
    onnxruntime-node and onnxruntime-web (WASM/WebGPU) runtimes accept.
    """

    def __init__(
        self,
        *,
        char_vocab_size: int,
        char_embed_dim: int,
        hidden_size: int,
        kernel_sizes: tuple[int, ...] = (3, 4, 5),
        pad_char_id: int = 0,
        dropout: float = 0.1,
    ) -> None:
        super().__init__()
        self.pad_char_id = pad_char_id
        self.char_embeddings = nn.Embedding(char_vocab_size, char_embed_dim, padding_idx=pad_char_id)
        # Split the hidden width across the kernels; the projection absorbs any remainder so the
        # output is exactly ``hidden_size`` regardless of divisibility.
        per_kernel = max(1, hidden_size // len(kernel_sizes))
        self.convs = nn.ModuleList(
            [nn.Conv1d(char_embed_dim, per_kernel, kernel_size=k, padding=k // 2) for k in kernel_sizes]
        )
        self.proj = nn.Linear(per_kernel * len(kernel_sizes), hidden_size)
        self.dropout = nn.Dropout(dropout)

    def forward(self, char_ids: torch.Tensor) -> torch.Tensor:
        # char_ids: (B, S, W) long. Fold (B, S) so the conv runs once over B*S tokens.
        bsz, seq, width = char_ids.shape
        flat = char_ids.reshape(bsz * seq, width)  # (B*S, W)
        # (B*S, W, D) -> (B*S, D, W) for Conv1d (channels = char_embed_dim).
        x = self.char_embeddings(flat).transpose(1, 2)
        # Mask padded char positions out of the max-pool: after ReLU real activations are >= 0, so a
        # padded column could otherwise win the max. Set padded columns to a large negative before pool.
        pad_mask = (flat == self.pad_char_id).unsqueeze(1)  # (B*S, 1, W)
        feats: list[torch.Tensor] = []
        for conv in self.convs:
            # Even kernels with symmetric padding emit W+1; trim to the input width so every kernel's
            # output aligns to the char positions (and the pad mask), for any kernel-size mix.
            c = torch.relu(conv(x))[..., :width]  # (B*S, per_kernel, W)
            c = c.masked_fill(pad_mask, -1e4)
            feats.append(c.max(dim=2).values)  # (B*S, per_kernel) — max over chars
        h: torch.Tensor = self.dropout(self.proj(torch.cat(feats, dim=-1)))  # (B*S, hidden)
        return h.reshape(bsz, seq, -1)  # (B, S, hidden)
