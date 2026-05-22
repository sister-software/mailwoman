"""Linear-chain CRF decoder for BIO tag sequences.

Adds two capabilities to the classifier:

1. **Structural validity at decode time.** The orphan-``I-*`` failure mode visible on the
   v0.2.0 demo (e.g. "Saint Petersburg" decoded as ``B-locality``, ``O``, ``I-locality``)
   becomes impossible — the transition matrix rejects any path that ends on ``I-X`` without
   a matching predecessor.

2. **Learned tag-dynamics prior.** Transitions like "``I-postcode`` rarely follows
   ``I-locality`` without an intermediate ``O``" get encoded in the learned transition
   scores. Helps when emissions are ambiguous.

Loss = -log P(gold_sequence | emissions) (CRF negative log-likelihood). Decoding =
Viterbi argmax over the same model. Both implemented in log-space for numerical stability.

Hand-rolled (not pytorch-crf) for the same reason ``EncoderBlock`` is hand-rolled in
``model.py``: keep the surface narrow + ONNX-clean, no third-party dep, and the team
controls the implementation.

ONNX-export caveat: the forward / Viterbi loops use Python control flow over the sequence
dim, which `torch.onnx.export` traces but cannot symbolically vectorize. For the
exported runtime we emit just the per-token emissions + transition tensors and run Viterbi
on the TS side (see ``export_onnx.py``).
"""

from __future__ import annotations

import torch
from torch import nn


def build_bio_transition_mask(id_to_label: dict[int, str]) -> torch.Tensor:
    """Return a ``(N, N)`` float mask: 0 for valid transitions, ``-inf`` for invalid.

    Rules for an inside-outside-begin (BIO) scheme:

    - ``X → O`` is always valid.
    - ``X → B-Y`` is always valid (any tag can start a new entity).
    - ``X → I-Y`` is valid only if ``X`` is ``B-Y`` or ``I-Y`` (matching tag).
      In particular, ``O → I-Y`` is invalid (orphan-``I`` — the bug this fixes).

    The mask is applied additively to learned transition logits, so invalid transitions
    contribute ``-inf`` to any path that uses them and Viterbi skips them.
    """
    n = len(id_to_label)
    mask = torch.zeros(n, n)
    for prev_id in range(n):
        prev_label = id_to_label[prev_id]
        for curr_id in range(n):
            curr_label = id_to_label[curr_id]
            if not _is_valid_transition(prev_label, curr_label):
                mask[prev_id, curr_id] = float("-inf")
    return mask


def build_bio_start_mask(id_to_label: dict[int, str]) -> torch.Tensor:
    """A sequence can't start on ``I-X``. Returns ``-inf`` for those, 0 otherwise."""
    n = len(id_to_label)
    mask = torch.zeros(n)
    for tag_id in range(n):
        label = id_to_label[tag_id]
        if label != "O" and label.startswith("I-"):
            mask[tag_id] = float("-inf")
    return mask


def _is_valid_transition(prev: str, curr: str) -> bool:
    if curr == "O":
        return True
    if "-" not in curr:
        return False  # malformed
    curr_prefix, curr_tag = curr.split("-", 1)
    if curr_prefix == "B":
        return True
    if curr_prefix != "I":
        return False
    # curr is I-X — must follow B-X or I-X
    if prev == "O" or "-" not in prev:
        return False
    prev_prefix, prev_tag = prev.split("-", 1)
    if prev_prefix not in ("B", "I"):
        return False
    return prev_tag == curr_tag


class LinearChainCRF(nn.Module):
    """Linear-chain CRF over BIO-labelled token sequences.

    Parameters: ``transitions`` (N×N), ``start_transitions`` (N), ``end_transitions`` (N).
    For 21 labels (Stage 2) that's 21² + 21 + 21 = 483 learnable scalars, negligible vs
    the 50K cited in #57.

    The BIO structural mask is registered as a buffer so it moves with ``.to(device)`` but
    isn't a learnable parameter — invalid transitions are pinned at ``-inf`` for all time.
    """

    def __init__(self, num_tags: int, id_to_label: dict[int, str]) -> None:
        super().__init__()
        if num_tags != len(id_to_label):
            raise ValueError(f"num_tags={num_tags} != len(id_to_label)={len(id_to_label)}")
        self.num_tags = num_tags
        self.transitions = nn.Parameter(torch.empty(num_tags, num_tags))
        self.start_transitions = nn.Parameter(torch.empty(num_tags))
        self.end_transitions = nn.Parameter(torch.empty(num_tags))
        nn.init.uniform_(self.transitions, -0.1, 0.1)
        nn.init.uniform_(self.start_transitions, -0.1, 0.1)
        nn.init.uniform_(self.end_transitions, -0.1, 0.1)

        self.register_buffer("transition_mask", build_bio_transition_mask(id_to_label))
        self.register_buffer("start_mask", build_bio_start_mask(id_to_label))

    def masked_transitions(self) -> torch.Tensor:
        return self.transitions + self.transition_mask

    def masked_start_transitions(self) -> torch.Tensor:
        return self.start_transitions + self.start_mask

    # --- training: negative log-likelihood ------------------------------------------

    def forward(
        self,
        emissions: torch.Tensor,
        tags: torch.Tensor,
        mask: torch.Tensor,
    ) -> torch.Tensor:
        """Return mean negative log-likelihood over the batch.

        Args:
            emissions: ``(batch, seq, num_tags)`` per-token emission scores.
            tags: ``(batch, seq)`` gold label IDs. Padding positions are ignored via ``mask``.
            mask: ``(batch, seq)`` 1 = real token, 0 = padding. Same dtype as ``emissions``.

        ``mask[:, 0]`` MUST be all 1s (no leading padding) — callers control padding shape.
        """
        if emissions.dim() != 3:
            raise ValueError(f"emissions must be (B, S, N), got {tuple(emissions.shape)}")
        # Squash -100 (IGNORE_INDEX) gold tags into 0 so gather doesn't index OOB; the
        # mask will zero out their contribution regardless.
        safe_tags = tags.clamp(min=0)

        numerator = self._score_sequence(emissions, safe_tags, mask)
        denominator = self._log_partition(emissions, mask)
        nll = denominator - numerator
        # Mean over batch (token-level normalization is implicit in the per-sequence score).
        return nll.mean()

    def _score_sequence(
        self,
        emissions: torch.Tensor,  # (B, S, N)
        tags: torch.Tensor,  # (B, S)
        mask: torch.Tensor,  # (B, S)
    ) -> torch.Tensor:
        bsz, seq_len, _ = emissions.shape
        # Start transition + first emission.
        score = self.masked_start_transitions()[tags[:, 0]] + emissions[:, 0].gather(
            1, tags[:, 0].unsqueeze(1)
        ).squeeze(1)

        # Iterate over sequence positions, accumulating transition + emission scores.
        masked_trans = self.masked_transitions()
        for t in range(1, seq_len):
            prev_tags = tags[:, t - 1]
            curr_tags = tags[:, t]
            trans_score = masked_trans[prev_tags, curr_tags]
            emit_score = emissions[:, t].gather(1, curr_tags.unsqueeze(1)).squeeze(1)
            step_score = trans_score + emit_score
            score = score + step_score * mask[:, t]

        # End transition uses the last non-padding token per row.
        last_tag = self._last_valid_tag(tags, mask)
        score = score + self.end_transitions[last_tag]
        return score

    def _log_partition(
        self,
        emissions: torch.Tensor,
        mask: torch.Tensor,
    ) -> torch.Tensor:
        bsz, seq_len, num_tags = emissions.shape
        # alpha[i, k] = log-sum-exp of all paths ending at tag k at position i
        alpha = self.masked_start_transitions().unsqueeze(0) + emissions[:, 0]  # (B, N)

        masked_trans = self.masked_transitions()  # (N, N)
        for t in range(1, seq_len):
            # broadcast: alpha (B, N, 1) + transitions (1, N, N) + emissions (B, 1, N)
            broadcast = alpha.unsqueeze(2) + masked_trans.unsqueeze(0) + emissions[:, t].unsqueeze(1)
            new_alpha = torch.logsumexp(broadcast, dim=1)  # (B, N)
            # alpha carries -inf for structurally invalid positions (e.g. starting on I-X);
            # a multiplicative blend (`alpha * (1 - mask_t)`) would compute 0 * -inf = NaN
            # whenever mask_t = 1 anywhere alpha is -inf. torch.where avoids the product.
            keep_new = mask[:, t].unsqueeze(1).bool()
            alpha = torch.where(keep_new, new_alpha, alpha)

        alpha = alpha + self.end_transitions.unsqueeze(0)
        return torch.logsumexp(alpha, dim=1)

    @staticmethod
    def _last_valid_tag(tags: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        # Find the index of the last 1 in each mask row, return the tag at that index.
        seq_len = tags.size(1)
        # idx of last real token = sum(mask) - 1
        lengths = mask.sum(dim=1).long() - 1  # (B,)
        lengths = lengths.clamp(min=0, max=seq_len - 1)
        return tags.gather(1, lengths.unsqueeze(1)).squeeze(1)

    # --- inference: Viterbi ----------------------------------------------------------

    @torch.no_grad()
    def viterbi_decode(
        self,
        emissions: torch.Tensor,
        mask: torch.Tensor,
    ) -> list[list[int]]:
        """Best path per row. Returns a list of variable-length tag sequences.

        Padding positions are dropped from the output — each returned list has length
        ``mask[row].sum()`` real tokens.
        """
        bsz, seq_len, num_tags = emissions.shape
        masked_trans = self.masked_transitions()

        # score[B, N] = best path score ending at tag N at time t
        score = self.masked_start_transitions().unsqueeze(0) + emissions[:, 0]
        history: list[torch.Tensor] = []

        for t in range(1, seq_len):
            broadcast = score.unsqueeze(2) + masked_trans.unsqueeze(0) + emissions[:, t].unsqueeze(1)
            best_prev = broadcast.argmax(dim=1)  # (B, N)
            best_score = broadcast.max(dim=1).values  # (B, N)
            # Same NaN trap as in _log_partition: score may carry -inf at structurally invalid
            # positions (start_mask), and `0 * -inf = NaN`. Use where(), not multiplicative blend.
            keep_new = mask[:, t].unsqueeze(1).bool()
            score = torch.where(keep_new, best_score, score)
            history.append(best_prev)

        score = score + self.end_transitions.unsqueeze(0)
        best_last = score.argmax(dim=1)  # (B,)

        # Backtrack.
        results: list[list[int]] = []
        for b in range(bsz):
            length = int(mask[b].sum().item())
            if length == 0:
                results.append([])
                continue
            tags = [int(best_last[b].item())]
            # history[t-1][b, tags[-1]] is the previous tag at position t-1
            for t in range(length - 1, 0, -1):
                prev = int(history[t - 1][b, tags[-1]].item())
                tags.append(prev)
            tags.reverse()
            results.append(tags)
        return results
