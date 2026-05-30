"""Masked-language-model token masking for self-supervised pre-training (pretrain.py).

BERT 80/10/10 masking over a batch of token ids:

  * select ``mask_prob`` of the ATTENDED (non-pad) positions, ~uniformly at random;
  * of the selected: 80% -> mask token, 10% -> random token, 10% -> unchanged;
  * the MLM target is the original id at selected positions, ``-100`` (ignore) elsewhere, so
    ``cross_entropy(ignore_index=-100)`` scores only the masked positions.

Mask token: the SentencePiece tokenizer has no dedicated ``[MASK]`` symbol, so callers pass the
``<unk>`` id. Padding uses id 0 and ``<unk>`` is id 1 — but pad positions carry
``attention_mask == 0`` and are never selected, while masked positions keep ``attention_mask == 1``,
so the encoder distinguishes them via attention. No embedding-table change -> the pretrain
checkpoint's state_dict stays key-identical to a supervised model's.
"""

from __future__ import annotations

import torch


def mask_tokens(
    input_ids: torch.Tensor,
    attention_mask: torch.Tensor,
    *,
    mask_prob: float,
    mask_token_id: int,
    vocab_size: int,
    generator: torch.Generator | None = None,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Return ``(masked_input_ids, mlm_labels)`` for a ``(batch, seq)`` batch.

    ``masked_input_ids`` is a corrupted copy; ``mlm_labels`` holds the original id at masked
    positions and ``-100`` everywhere else. Deterministic given ``generator``. Operates on CPU
    tensors (the caller moves results to device) so the RNG stream is device-independent.
    """
    labels = input_ids.clone()
    attended = attention_mask.bool()

    # 1. choose positions: bernoulli(mask_prob) restricted to attended (non-pad) tokens.
    probs = torch.full(input_ids.shape, float(mask_prob)) * attended.float()
    selected = torch.bernoulli(probs, generator=generator).bool()
    labels[~selected] = -100

    masked = input_ids.clone()

    # 2. 80% of selected -> mask token.
    to_mask = torch.bernoulli(torch.full(input_ids.shape, 0.8), generator=generator).bool() & selected
    masked[to_mask] = mask_token_id

    # 3. 10% of selected -> random token (half of the remaining 20%).
    to_random = (
        torch.bernoulli(torch.full(input_ids.shape, 0.5), generator=generator).bool()
        & selected
        & ~to_mask
    )
    random_ids = torch.randint(0, vocab_size, input_ids.shape, generator=generator)
    masked[to_random] = random_ids[to_random]

    # 4. remaining ~10% of selected -> left unchanged (already correct in `masked`).
    return masked, labels
