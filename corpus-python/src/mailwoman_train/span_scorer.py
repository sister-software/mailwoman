"""#727 stage-2 — the semi-Markov span scorer.

The flat BIO head decodes T independent token choices, so "these k tokens are ONE street" is an
emergent property of token votes rather than a scored decision. This module makes a segmentation a
first-class hypothesis: every span up to ``max_span`` tokens gets a per-type score, a segment-level
transition table carries the address grammar (the level at which "must not follow" is well-posed —
5-8 segments, not 40 subwords), and the whole segmentation is scored jointly.

Phase 1 scope: scoring + loss + decode, evaluated in Python. Export/JS/rerank are later phases; see
docs/superpowers/plans/2026-07-15-727-stage2-kbest-plan.md and the phase-1 plan beside it.

fp32 discipline: the forward algorithm exponentiates sums over exponentially many segmentations. The
v0.5.0 bf16 CRF NaN scar applies to exactly this arithmetic, so every DP here runs in fp32 regardless
of the ambient autocast dtype.
"""

from __future__ import annotations

import torch
from torch import nn

from .labels import ACTIVE_BIO_LABELS, ID_TO_LABEL, IGNORE_INDEX


def _derive_segment_types() -> tuple[str, ...]:
    """``("O", <component>, …)`` derived from the BIO vocab. Never hardcoded (PLACETYPE_ORDER class)."""
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
    """BIO label ids -> ``[(start, length, type_id), …]`` covering every non-ignore token.

    Returns ``(segments, representable)``. ``representable`` is False when any gold segment is longer
    than ``max_span`` — such a row cannot be scored by the semi-CRF and its loss term must be skipped
    (silently truncating would teach a wrong boundary, which is the defect this arc exists to fix).
    """
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
        # Consume the B- (or an orphan I-, defensively) plus every following I- of the same component.
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
    """Score every span up to ``max_span`` tokens, per segment type.

    ``score[b, i, l, t]`` = the segment starting at token ``i``, length ``l + 1``, type ``t``.
    Additive biaffine: ``type_out(tanh(start_proj(h)[i] + end_proj(h)[j]))`` with ``j = i + l``. Chosen
    over a full bilinear because Phase 3 re-implements it in JS per candidate span — one add, one tanh,
    one matmul, no dynamic-shape ONNX op.

    Spans that run past the sequence end are scored against a zero end-vector; the DP masks them out,
    so their value is never read.
    """

    def __init__(self, hidden_size: int, span_dim: int, max_span: int) -> None:
        super().__init__()
        self.max_span = int(max_span)
        self.start_proj = nn.Linear(hidden_size, span_dim)
        self.end_proj = nn.Linear(hidden_size, span_dim)
        self.type_out = nn.Linear(span_dim, NUM_SEGMENT_TYPES)

    def forward(self, h: torch.Tensor) -> torch.Tensor:
        starts = self.start_proj(h)  # (B, S, D)
        ends = self.end_proj(h)  # (B, S, D)
        # shifted[:, i, l, :] == ends[:, i + l, :]  (zero-padded past the end)
        shifted = torch.stack(
            [nn.functional.pad(ends, (0, 0, 0, offset))[:, offset:, :] for offset in range(self.max_span)],
            dim=2,
        )  # (B, S, L, D)
        span_h = torch.tanh(starts.unsqueeze(2) + shifted)  # (B, S, L, D)
        return self.type_out(span_h)  # (B, S, L, T)


# Finite sentinel rather than -inf: an all-masked row's logsumexp would be -inf - (-inf) = NaN, and
# the v0.5.0 CRF NaN scar says do not hand this arithmetic an opportunity.
_NEG_INF = -1e4


class SemiMarkovCRF(nn.Module):
    """Semi-Markov CRF over segmentations, with a segment-level transition grammar.

    The linear-chain CRF this project abandoned (v0.5.0, bf16 NaN) modelled transitions between
    SUBWORD tags — mostly noise ("must `1` follow `▁8`" is not grammar). At segment granularity the
    same table is well-posed: house_number -> street, one postcode per reading, venue before locality.
    Sequences are 5-8 segments, not 40 subwords.

    All DP is fp32 (see module docstring). ``O`` segments are length 1 by construction: every
    non-entity token is its own O segment, which keeps the DP small and matches the word-level O
    handling the Phase 3 JS decoder will use.
    """

    def __init__(self, max_span: int) -> None:
        super().__init__()
        self.max_span = int(max_span)
        self.transitions = nn.Parameter(torch.zeros(NUM_SEGMENT_TYPES, NUM_SEGMENT_TYPES))
        self.start_transitions = nn.Parameter(torch.zeros(NUM_SEGMENT_TYPES))
        self.end_transitions = nn.Parameter(torch.zeros(NUM_SEGMENT_TYPES))

    def _length_mask(self, device: torch.device) -> torch.Tensor:
        """(L, T) additive mask: forbid an O segment longer than 1 token."""
        mask = torch.zeros(self.max_span, NUM_SEGMENT_TYPES, device=device)
        if self.max_span > 1:
            mask[1:, O_TYPE_ID] = _NEG_INF
        return mask

    def log_partition(self, span_scores: torch.Tensor, lengths: torch.Tensor) -> torch.Tensor:
        """log Z — the log-sum-exp over every valid segmentation. fp32 regardless of input dtype."""
        scores = span_scores.float() + self._length_mask(span_scores.device)  # (B,S,L,T)
        batch, seq_len, _, num_types = scores.shape
        trans = self.transitions.float()
        # alpha[:, j, k] = logsumexp over segmentations of the prefix [0, j) whose last type is k.
        alpha = scores.new_full((batch, seq_len + 1, num_types), _NEG_INF)
        for j in range(1, seq_len + 1):
            cands = []
            for span_len in range(1, min(self.max_span, j) + 1):
                i = j - span_len
                seg = scores[:, i, span_len - 1, :]  # (B,T)
                if i == 0:
                    prev = self.start_transitions.float().unsqueeze(0).expand(batch, num_types)
                else:
                    prev = torch.logsumexp(alpha[:, i, :].unsqueeze(2) + trans.unsqueeze(0), dim=1)
                cands.append(prev + seg)
            alpha = alpha.clone()
            alpha[:, j, :] = torch.logsumexp(torch.stack(cands, dim=0), dim=0)
        # Read each row at its OWN length, then close with the end transitions.
        idx = lengths.to(alpha.device).view(batch, 1, 1).expand(batch, 1, num_types)
        final = alpha.gather(1, idx).squeeze(1)  # (B,T)
        return torch.logsumexp(final + self.end_transitions.float().unsqueeze(0), dim=1)

    def score_segmentation(self, span_scores: torch.Tensor, segments: list[list[tuple[int, int, int]]]) -> torch.Tensor:
        """Score of one given segmentation per row (the numerator of the NLL)."""
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
        """-log p(gold segmentation) = log Z - score(gold).

        Phase 1's training objective. Rows whose gold is not representable under ``max_span`` must be
        filtered out by the caller — see ``gold_segments``' ``representable`` flag.
        """
        return self.log_partition(span_scores, lengths) - self.score_segmentation(span_scores, segments)

    @torch.no_grad()
    def decode(self, span_scores: torch.Tensor, lengths: torch.Tensor) -> list[list[tuple[int, int, int]]]:
        """Argmax segmentation per row — same recurrence as ``log_partition`` with max for logsumexp.

        Phase 3 extends this to k-best (keep the top-k per state instead of the max); the 1-best form
        is what Phase 1's ``seg@1`` gate needs.
        """
        scores = span_scores.float() + self._length_mask(span_scores.device)
        batch, _, _, num_types = scores.shape
        trans = self.transitions.float()
        results: list[list[tuple[int, int, int]]] = []
        for row in range(batch):
            n = int(lengths[row])
            delta = torch.full((n + 1, num_types), _NEG_INF, device=scores.device)
            back: dict[tuple[int, int], tuple[int, int]] = {}  # (j, type) -> (length, prev_type)
            for j in range(1, n + 1):
                for span_len in range(1, min(self.max_span, j) + 1):
                    i = j - span_len
                    seg = scores[row, i, span_len - 1, :]  # (T,)
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
