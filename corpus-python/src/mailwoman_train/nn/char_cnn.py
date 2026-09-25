from __future__ import annotations

import torch
from torch import nn


class CharCNNEmbedding(nn.Module):
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

        per_kernel = max(1, hidden_size // len(kernel_sizes))
        self.convs = nn.ModuleList(
            [nn.Conv1d(char_embed_dim, per_kernel, kernel_size=k, padding=k // 2) for k in kernel_sizes]
        )
        self.proj = nn.Linear(per_kernel * len(kernel_sizes), hidden_size)
        self.dropout = nn.Dropout(dropout)

    def forward(self, char_ids: torch.Tensor) -> torch.Tensor:

        bsz, seq, width = char_ids.shape
        flat = char_ids.reshape(bsz * seq, width)

        x = self.char_embeddings(flat).transpose(1, 2)

        pad_mask = (flat == self.pad_char_id).unsqueeze(1)
        feats: list[torch.Tensor] = []
        for conv in self.convs:
            c = torch.relu(conv(x))[..., :width]
            c = c.masked_fill(pad_mask, -1e4)
            feats.append(c.max(dim=2).values)
        h: torch.Tensor = self.dropout(self.proj(torch.cat(feats, dim=-1)))
        return h.reshape(bsz, seq, -1)
