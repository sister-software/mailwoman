from __future__ import annotations

import torch
from torch import nn

from ..labels import ACTIVE_BIO_LABELS, ID_TO_LABEL, IGNORE_INDEX


def _derive_segment_types() -> tuple[str, ...]:
    seen: list[str] = []
    for label in ACTIVE_BIO_LABELS:
        if label == "O":
            continue
        component = label.split("-", 1)[1]
        if component not in seen:
            seen.append(component)
    return ("O", *seen)


SEGMENT_TYPES: tuple[str, ...] = _derive_segment_types()
TYPE_TO_ID: dict[str, int] = {t: i for i, t in enumerate(SEGMENT_TYPES)}
NUM_SEGMENT_TYPES: int = len(SEGMENT_TYPES)
O_TYPE_ID: int = TYPE_TO_ID["O"]


def gold_segments(labels_row: list[int], max_span: int) -> tuple[list[tuple[int, int, int]], bool]:
    segments: list[tuple[int, int, int]] = []
    representable = True
    i = 0
    n = len(labels_row)
    while i < n:
        label_id = labels_row[i]
        if label_id == IGNORE_INDEX:
            break
        label = ID_TO_LABEL[label_id]
        if label == "O":
            segments.append((i, 1, O_TYPE_ID))
            i += 1
            continue
        component = label.split("-", 1)[1]

        length = 1
        while i + length < n and labels_row[i + length] != IGNORE_INDEX:
            nxt = ID_TO_LABEL[labels_row[i + length]]
            if nxt != f"I-{component}":
                break
            length += 1
        if length > max_span:
            representable = False
        segments.append((i, length, TYPE_TO_ID[component]))
        i += length
    return segments, representable


class SpanScorer(nn.Module):
    def __init__(self, hidden_size: int, span_dim: int, max_span: int) -> None:
        super().__init__()
        self.max_span = int(max_span)
        self.start_proj = nn.Linear(hidden_size, span_dim)
        self.end_proj = nn.Linear(hidden_size, span_dim)
        self.type_out = nn.Linear(span_dim, NUM_SEGMENT_TYPES)

    def forward(self, h: torch.Tensor) -> torch.Tensor:
        starts = self.start_proj(h)
        ends = self.end_proj(h)

        shifted = torch.stack(
            [nn.functional.pad(ends, (0, 0, 0, offset))[:, offset:, :] for offset in range(self.max_span)],
            dim=2,
        )
        span_h = torch.tanh(starts.unsqueeze(2) + shifted)
        type_out: torch.Tensor = self.type_out(span_h)
        return type_out


_NEG_INF = -1e4


class SemiMarkovCRF(nn.Module):
    def __init__(self, max_span: int) -> None:
        super().__init__()
        self.max_span = int(max_span)
        self.transitions = nn.Parameter(torch.zeros(NUM_SEGMENT_TYPES, NUM_SEGMENT_TYPES))
        self.start_transitions = nn.Parameter(torch.zeros(NUM_SEGMENT_TYPES))
        self.end_transitions = nn.Parameter(torch.zeros(NUM_SEGMENT_TYPES))

    def _length_mask(self, device: torch.device) -> torch.Tensor:
        mask = torch.zeros(self.max_span, NUM_SEGMENT_TYPES, device=device)
        if self.max_span > 1:
            mask[1:, O_TYPE_ID] = _NEG_INF
        return mask

    def log_partition(self, span_scores: torch.Tensor, lengths: torch.Tensor) -> torch.Tensor:
        scores = span_scores.float() + self._length_mask(span_scores.device)
        batch, seq_len, _, num_types = scores.shape
        trans = self.transitions.float()

        alpha = scores.new_full((batch, seq_len + 1, num_types), _NEG_INF)
        for j in range(1, seq_len + 1):
            cands = []
            for span_len in range(1, min(self.max_span, j) + 1):
                i = j - span_len
                seg = scores[:, i, span_len - 1, :]
                if i == 0:
                    prev = self.start_transitions.float().unsqueeze(0).expand(batch, num_types)
                else:
                    prev = torch.logsumexp(alpha[:, i, :].unsqueeze(2) + trans.unsqueeze(0), dim=1)
                cands.append(prev + seg)
            alpha = alpha.clone()
            alpha[:, j, :] = torch.logsumexp(torch.stack(cands, dim=0), dim=0)

        idx = lengths.to(alpha.device).view(batch, 1, 1).expand(batch, 1, num_types)
        final = alpha.gather(1, idx).squeeze(1)
        return torch.logsumexp(final + self.end_transitions.float().unsqueeze(0), dim=1)

    def score_segmentation(self, span_scores: torch.Tensor, segments: list[list[tuple[int, int, int]]]) -> torch.Tensor:
        scores = span_scores.float()
        out = []
        for b_i, segmentation in enumerate(segments):
            total = scores.new_zeros(())
            prev: int | None = None
            for i, length, t in segmentation:
                total = total + scores[b_i, i, length - 1, t]
                total = total + (
                    self.start_transitions.float()[t] if prev is None else self.transitions.float()[prev, t]
                )
                prev = t
            if prev is not None:
                total = total + self.end_transitions.float()[prev]
            out.append(total)
        return torch.stack(out)

    def nll(
        self,
        span_scores: torch.Tensor,
        segments: list[list[tuple[int, int, int]]],
        lengths: torch.Tensor,
    ) -> torch.Tensor:
        return self.log_partition(span_scores, lengths) - self.score_segmentation(span_scores, segments)

    @torch.no_grad()
    def decode(self, span_scores: torch.Tensor, lengths: torch.Tensor) -> list[list[tuple[int, int, int]]]:
        scores = span_scores.float() + self._length_mask(span_scores.device)
        batch, _, _, num_types = scores.shape
        trans = self.transitions.float()
        results: list[list[tuple[int, int, int]]] = []
        for row in range(batch):
            n = int(lengths[row])
            delta = torch.full((n + 1, num_types), _NEG_INF, device=scores.device)
            back: dict[tuple[int, int], tuple[int, int]] = {}
            for j in range(1, n + 1):
                for span_len in range(1, min(self.max_span, j) + 1):
                    i = j - span_len
                    seg = scores[row, i, span_len - 1, :]
                    if i == 0:
                        cand = self.start_transitions.float() + seg
                        prev_types = torch.full((num_types,), -1, dtype=torch.long, device=scores.device)
                    else:
                        prev_best, prev_arg = (delta[i].unsqueeze(1) + trans).max(dim=0)
                        cand = prev_best + seg
                        prev_types = prev_arg
                    better = cand > delta[j]
                    for type_id in torch.nonzero(better, as_tuple=False).flatten().tolist():
                        delta[j, type_id] = cand[type_id]
                        back[(j, type_id)] = (span_len, int(prev_types[type_id]))
            final = delta[n] + self.end_transitions.float()
            segmentation: list[tuple[int, int, int]] = []
            j, type_id = n, int(final.argmax())
            while j > 0:
                span_len, prev_type = back[(j, type_id)]
                segmentation.append((j - span_len, span_len, type_id))
                j -= span_len
                type_id = prev_type
            results.append(list(reversed(segmentation)))
        return results
