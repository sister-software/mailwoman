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

v0.5.0 thread C: ``top_k_decode`` returns the K most-probable tag sequences (list-Viterbi
over the same structural mask). Consumed by Stage 5 reconcile (Thread D) so it can
disambiguate kryptonite cases like ``NY-NY Steakhouse, Houston, TX`` jointly across
classifier candidates + resolver candidates + concordance score.
"""

from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import nn


@dataclass
class TopKPath:
    """One decoded tag sequence with its calibrated log-probability score.

    ``score`` is ``path_log_score - log_partition`` — a valid log P(path | emissions) under
    the CRF distribution, with ``sum_paths exp(score) <= 1``. Stage 5 reconcile uses these
    as the classifier's belief over candidate parses.
    """

    sequence: list[int]
    score: float


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
        reduction: str = "mean",
    ) -> torch.Tensor:
        """Return negative log-likelihood, reduced over the batch.

        Args:
            emissions: ``(batch, seq, num_tags)`` per-token emission scores.
            tags: ``(batch, seq)`` gold label IDs. Padding positions are ignored via ``mask``.
            mask: ``(batch, seq)`` 1 = real token, 0 = padding. Same dtype as ``emissions``.
            reduction: one of:

                - ``"mean"`` (default, v0.3.0 behavior) — mean NLL over batch sequences.
                  Per-sequence magnitude scales with sequence length; this is the form
                  v0.3.0's dual loss hand-weighted via ``crf_loss_weight=0.05``.
                - ``"per_token"`` (v0.4.0) — sum NLL across batch, divide by total real
                  tokens. Self-balances against per-token CE, eliminating the need for
                  ``crf_loss_weight`` tuning. Matches AllenNLP / FLAIR defaults.
                - ``"sum"`` — sum over batch sequences. Internal use; callers normalize.

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
        if reduction == "mean":
            return nll.mean()
        if reduction == "sum":
            return nll.sum()
        if reduction == "per_token":
            # Sum NLL across batch / total real tokens. Clamped to 1 to defend against
            # empty-batch edge cases (all-padding batches shouldn't reach here in
            # practice but the clamp keeps gradient well-defined).
            total_tokens = mask.sum().clamp(min=1)
            return nll.sum() / total_tokens
        raise ValueError(f"unknown reduction: {reduction!r}; expected mean | sum | per_token")

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

    @torch.no_grad()
    def top_k_decode(
        self,
        emissions: torch.Tensor,
        mask: torch.Tensor,
        k: int = 5,
    ) -> list[list[TopKPath]]:
        """Top-K most-probable tag sequences per row, sorted by score descending.

        List-Viterbi (k-best dynamic programming): for each (time, state) cell we keep
        the K best path-scores ending at that state, with backpointers to (prev_state,
        prev_rank). After processing the sequence, the K best paths are read off the
        last column by sorting end-augmented scores and backtracking through ``(state,
        rank)`` history.

        Each path's score is converted to ``log P(path | emissions)`` by subtracting the
        log-partition. The result is a calibrated belief over candidate parses — the
        Stage 5 reconcile (Thread D) input.

        Args:
            emissions: ``(batch, seq, num_tags)`` per-token emission scores.
            mask: ``(batch, seq)`` 1 = real token, 0 = padding. Same dtype as ``emissions``.
            k: maximum number of paths to return per row. Returned list may be shorter
               when fewer structurally-valid paths exist (e.g. ``num_tags ** length < k``
               on a tiny sequence).

        Returns:
            Per-row list of ``TopKPath(sequence, score)`` items, sorted by score desc.
            ``sequence`` length equals ``mask[row].sum()``; padding is dropped.

        Complexity: ``O(B * T * N² * K * log(N * K))`` where N=num_tags, K=k, T=seq_len.
        For N=21, K=5, T=128, B=32 this is ~10M ops — negligible compared to the encoder
        forward pass. Implemented per-row on CPU after `.cpu()` to keep the topk + backtrack
        readable; the call site is inference, not training, so GPU residency doesn't matter.
        """
        if k < 1:
            raise ValueError(f"k must be >= 1, got {k}")
        bsz, seq_len, num_tags = emissions.shape

        # Compute log-partition once (per-row) so we can return calibrated log-probs.
        log_partition = self._log_partition(emissions, mask)  # (B,)

        masked_trans = self.masked_transitions().detach()  # (N, N)
        start_trans = self.masked_start_transitions().detach()  # (N,)
        end_trans = self.end_transitions.detach()  # (N,)

        results: list[list[TopKPath]] = []
        # Per-row decode. Lengths vary, structural masks introduce -inf, and the topk on
        # the broadcast cube is cleanest one row at a time.
        for b in range(bsz):
            length = int(mask[b].sum().item())
            if length == 0:
                results.append([])
                continue

            em = emissions[b].detach()  # (S, N)
            row_logZ = float(log_partition[b].item())
            row_paths = _row_top_k(
                emissions=em,
                length=length,
                num_tags=num_tags,
                start_trans=start_trans,
                end_trans=end_trans,
                masked_trans=masked_trans,
                k=k,
                log_partition=row_logZ,
            )
            results.append(row_paths)
        return results


def _row_top_k(
    *,
    emissions: torch.Tensor,  # (S, N)
    length: int,
    num_tags: int,
    start_trans: torch.Tensor,  # (N,)
    end_trans: torch.Tensor,  # (N,)
    masked_trans: torch.Tensor,  # (N, N)
    k: int,
    log_partition: float,
) -> list[TopKPath]:
    """Single-row k-best Viterbi. Pure-tensor; ``length`` trims padding."""
    # score[t, j, r] = r-th best path-score ending at tag j at time t.
    # backptr[t, j, r] = (prev_tag, prev_rank) of the predecessor for that path.
    # Use -inf to flag "no path here yet" so structurally-invalid extensions stay invalid.
    NEG_INF = float("-inf")

    # t=0 init: only rank 0 is real; ranks 1..K-1 are -inf with no predecessor.
    score = torch.full((num_tags, k), NEG_INF, dtype=emissions.dtype)
    score[:, 0] = start_trans + emissions[0]
    # backptr_tag[t][j, r] = prev_tag; backptr_rank[t][j, r] = prev_rank. Stored per-step.
    backptr_tag: list[torch.Tensor] = []
    backptr_rank: list[torch.Tensor] = []

    for t in range(1, length):
        # candidates[i, m, j] = score[t-1, i, m] + trans[i, j] + emit[j]
        # Shape: (N, K, N). Reshape to (N*K, N) so topk-over-predecessors is a single dim.
        candidates = (
            score.unsqueeze(2)  # (N, K, 1)
            + masked_trans.unsqueeze(1)  # (N, 1, N)
            + emissions[t].unsqueeze(0).unsqueeze(0)  # (1, 1, N)
        )  # (N, K, N)
        # For each destination tag j, pick top-K predecessors from the N*K candidates.
        flat = candidates.permute(2, 0, 1).reshape(num_tags, num_tags * k)  # (N_dest, N*K)
        # k may exceed N*K only at t=1 (when previous step has K-1 -inf ranks); topk handles
        # by returning -inf for over-budget ranks, which propagate as "no path."
        kk = min(k, flat.size(1))
        top_vals, top_idx = flat.topk(kk, dim=1)  # (N_dest, kk)
        new_score = torch.full((num_tags, k), NEG_INF, dtype=emissions.dtype)
        new_score[:, :kk] = top_vals
        # Decode (prev_tag, prev_rank) from flat index = prev_tag * K + prev_rank.
        prev_tag = (top_idx // k).long()  # (N_dest, kk)
        prev_rank = (top_idx % k).long()  # (N_dest, kk)
        tag_full = torch.full((num_tags, k), -1, dtype=torch.long)
        rank_full = torch.full((num_tags, k), -1, dtype=torch.long)
        tag_full[:, :kk] = prev_tag
        rank_full[:, :kk] = prev_rank
        backptr_tag.append(tag_full)
        backptr_rank.append(rank_full)
        score = new_score

    # End-augment, flatten over (tag, rank), pick top-K overall.
    final = score + end_trans.unsqueeze(1)  # (N, K)
    flat_final = final.reshape(-1)  # (N*K,)
    kk = min(k, flat_final.numel())
    top_final_vals, top_final_idx = flat_final.topk(kk)
    # Drop -inf entries — they correspond to invalid / nonexistent paths.
    paths: list[TopKPath] = []
    for v, idx in zip(top_final_vals.tolist(), top_final_idx.tolist()):
        if v == NEG_INF or v != v:  # NaN guard
            continue
        end_tag = int(idx // k)
        end_rank = int(idx % k)
        # Backtrack.
        seq = [end_tag]
        cur_tag, cur_rank = end_tag, end_rank
        for t in range(length - 1, 0, -1):
            bt = backptr_tag[t - 1]
            br = backptr_rank[t - 1]
            prev_tag = int(bt[cur_tag, cur_rank].item())
            prev_rank = int(br[cur_tag, cur_rank].item())
            if prev_tag < 0:
                # Hit an unfilled slot — path is shorter than ``length``; skip.
                seq = []
                break
            seq.append(prev_tag)
            cur_tag, cur_rank = prev_tag, prev_rank
        if not seq:
            continue
        seq.reverse()
        paths.append(TopKPath(sequence=seq, score=float(v) - log_partition))
    # topk already returned in desc order; keep that property after filtering.
    return paths
