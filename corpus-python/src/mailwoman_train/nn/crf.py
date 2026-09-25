from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import nn


@dataclass
class TopKPath:
    sequence: list[int]
    score: float


def build_bio_transition_mask(id_to_label: dict[int, str]) -> torch.Tensor:
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
        return False
    curr_prefix, curr_tag = curr.split("-", 1)
    if curr_prefix == "B":
        return True
    if curr_prefix != "I":
        return False

    if prev == "O" or "-" not in prev:
        return False
    prev_prefix, prev_tag = prev.split("-", 1)
    if prev_prefix not in ("B", "I"):
        return False
    return prev_tag == curr_tag


class LinearChainCRF(nn.Module):
    transition_mask: torch.Tensor
    start_mask: torch.Tensor

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

    def forward(
        self,
        emissions: torch.Tensor,
        tags: torch.Tensor,
        mask: torch.Tensor,
        reduction: str = "mean",
    ) -> torch.Tensor:
        if emissions.dim() != 3:
            raise ValueError(f"emissions must be (B, S, N), got {tuple(emissions.shape)}")

        safe_tags = tags.clamp(min=0)

        numerator = self._score_sequence(emissions, safe_tags, mask)
        denominator = self._log_partition(emissions, mask)
        nll = denominator - numerator
        if reduction == "mean":
            return nll.mean()
        if reduction == "sum":
            return nll.sum()
        if reduction == "per_token":
            total_tokens = mask.sum().clamp(min=1)
            return nll.sum() / total_tokens
        raise ValueError(f"unknown reduction: {reduction!r}; expected mean | sum | per_token")

    def _score_sequence(
        self,
        emissions: torch.Tensor,
        tags: torch.Tensor,
        mask: torch.Tensor,
    ) -> torch.Tensor:
        bsz, seq_len, _ = emissions.shape

        score = self.masked_start_transitions()[tags[:, 0]] + emissions[:, 0].gather(
            1, tags[:, 0].unsqueeze(1)
        ).squeeze(1)

        masked_trans = self.masked_transitions()
        for t in range(1, seq_len):
            prev_tags = tags[:, t - 1]
            curr_tags = tags[:, t]
            trans_score = masked_trans[prev_tags, curr_tags]
            emit_score = emissions[:, t].gather(1, curr_tags.unsqueeze(1)).squeeze(1)
            step_score = trans_score + emit_score
            score = score + step_score * mask[:, t]

        last_tag = self._last_valid_tag(tags, mask)
        score = score + self.end_transitions[last_tag]
        return score

    def _log_partition(
        self,
        emissions: torch.Tensor,
        mask: torch.Tensor,
    ) -> torch.Tensor:
        bsz, seq_len, num_tags = emissions.shape

        alpha = self.masked_start_transitions().unsqueeze(0) + emissions[:, 0]

        masked_trans = self.masked_transitions()
        for t in range(1, seq_len):
            broadcast = alpha.unsqueeze(2) + masked_trans.unsqueeze(0) + emissions[:, t].unsqueeze(1)
            new_alpha = torch.logsumexp(broadcast, dim=1)

            keep_new = mask[:, t].unsqueeze(1).bool()
            alpha = torch.where(keep_new, new_alpha, alpha)

        alpha = alpha + self.end_transitions.unsqueeze(0)
        return torch.logsumexp(alpha, dim=1)

    @staticmethod
    def _last_valid_tag(tags: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:

        seq_len = tags.size(1)

        lengths = mask.sum(dim=1).long() - 1
        lengths = lengths.clamp(min=0, max=seq_len - 1)
        return tags.gather(1, lengths.unsqueeze(1)).squeeze(1)

    @torch.no_grad()
    def viterbi_decode(
        self,
        emissions: torch.Tensor,
        mask: torch.Tensor,
    ) -> list[list[int]]:
        bsz, seq_len, num_tags = emissions.shape
        masked_trans = self.masked_transitions()

        score = self.masked_start_transitions().unsqueeze(0) + emissions[:, 0]
        history: list[torch.Tensor] = []

        for t in range(1, seq_len):
            broadcast = score.unsqueeze(2) + masked_trans.unsqueeze(0) + emissions[:, t].unsqueeze(1)
            best_prev = broadcast.argmax(dim=1)
            best_score = broadcast.max(dim=1).values

            keep_new = mask[:, t].unsqueeze(1).bool()
            score = torch.where(keep_new, best_score, score)
            history.append(best_prev)

        score = score + self.end_transitions.unsqueeze(0)
        best_last = score.argmax(dim=1)

        results: list[list[int]] = []
        for b in range(bsz):
            length = int(mask[b].sum().item())
            if length == 0:
                results.append([])
                continue
            tags = [int(best_last[b].item())]

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
        if k < 1:
            raise ValueError(f"k must be >= 1, got {k}")
        bsz, seq_len, num_tags = emissions.shape

        log_partition = self._log_partition(emissions, mask)

        masked_trans = self.masked_transitions().detach()
        start_trans = self.masked_start_transitions().detach()
        end_trans = self.end_transitions.detach()

        results: list[list[TopKPath]] = []

        for b in range(bsz):
            length = int(mask[b].sum().item())
            if length == 0:
                results.append([])
                continue

            em = emissions[b].detach()
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
    emissions: torch.Tensor,
    length: int,
    num_tags: int,
    start_trans: torch.Tensor,
    end_trans: torch.Tensor,
    masked_trans: torch.Tensor,
    k: int,
    log_partition: float,
) -> list[TopKPath]:

    NEG_INF = float("-inf")

    score = torch.full((num_tags, k), NEG_INF, dtype=emissions.dtype)
    score[:, 0] = start_trans + emissions[0]

    backptr_tag: list[torch.Tensor] = []
    backptr_rank: list[torch.Tensor] = []

    for t in range(1, length):
        candidates = score.unsqueeze(2) + masked_trans.unsqueeze(1) + emissions[t].unsqueeze(0).unsqueeze(0)

        flat = candidates.permute(2, 0, 1).reshape(num_tags, num_tags * k)

        kk = min(k, flat.size(1))
        top_vals, top_idx = flat.topk(kk, dim=1)
        new_score = torch.full((num_tags, k), NEG_INF, dtype=emissions.dtype)
        new_score[:, :kk] = top_vals

        prev_tag = (top_idx // k).long()
        prev_rank = (top_idx % k).long()
        tag_full = torch.full((num_tags, k), -1, dtype=torch.long)
        rank_full = torch.full((num_tags, k), -1, dtype=torch.long)
        tag_full[:, :kk] = prev_tag
        rank_full[:, :kk] = prev_rank
        backptr_tag.append(tag_full)
        backptr_rank.append(rank_full)
        score = new_score

    final = score + end_trans.unsqueeze(1)
    flat_final = final.reshape(-1)
    kk = min(k, flat_final.numel())
    top_final_vals, top_final_idx = flat_final.topk(kk)

    paths: list[TopKPath] = []
    for v, idx in zip(top_final_vals.tolist(), top_final_idx.tolist(), strict=True):
        if v == NEG_INF or v != v:
            continue
        end_tag = int(idx // k)
        end_rank = int(idx % k)

        seq = [end_tag]
        cur_tag, cur_rank = end_tag, end_rank
        for t in range(length - 1, 0, -1):
            bt = backptr_tag[t - 1]
            br = backptr_rank[t - 1]
            bt_tag = int(bt[cur_tag, cur_rank].item())
            bt_rank = int(br[cur_tag, cur_rank].item())
            if bt_tag < 0:
                seq = []
                break
            seq.append(bt_tag)
            cur_tag, cur_rank = bt_tag, bt_rank
        if not seq:
            continue
        seq.reverse()
        paths.append(TopKPath(sequence=seq, score=float(v) - log_partition))

    return paths
