"""Composing the supervised loss and its auxiliary terms.

None of these terms appears in `logits`, so a term that stops firing changes what the model learns
and no term the inference path returns. Every reduction that could divide by an empty count guards
its own case, and every structural term runs in fp32 — a bf16 reduction is a known NaN source.
"""

from __future__ import annotations

from typing import Any

import torch
from torch import nn

from ...labels import IGNORE_INDEX
from ..span_scorer import gold_segments
from .state import CoarseEncoderState


class CoarseEncoderLosses(CoarseEncoderState):
    """The loss-composition half of `MailwomanCoarseEncoder`."""

    def _compute_losses(
        self,
        *,
        hidden: torch.Tensor,
        logits: torch.Tensor,
        labels: torch.Tensor | None,
        attention_mask: torch.Tensor | None,
        locale_ids: torch.Tensor | None,
        locale_logits: torch.Tensor | None,
        affix_logits: torch.Tensor | None,
    ) -> tuple[torch.Tensor | None, torch.Tensor | None]:
        """The supervised loss, its auxiliary terms, and the span scores.

        Token CE (with the optional CRF NLL beside it), the affix head's own CE, the locale
        auxiliary CE, the span-boundary BCE, and the semi-Markov span NLL each switch on by their
        own config flag and are summed into one scalar. Answers `None` for the loss when no term
        fired, which is inference. The span scores come back separately because they are an output
        rather than a loss: the export path reads them.
        """
        loss: torch.Tensor | None = None
        if labels is not None:
            ce_logits = logits
            if self.use_conventions_loss_mask and locale_ids is not None:
                # IGNORE_INDEX rows clamp to locale 0 (US), whose mask row is all-zero — a no-op.
                rows = self.conventions_forbidden[locale_ids.clamp_min(0)]
                ce_logits = logits.masked_fill(rows.unsqueeze(1).bool(), -1e9)
            ce_kwargs: dict[str, Any] = {
                "ignore_index": -100,
                "label_smoothing": self.label_smoothing,
            }
            if isinstance(self.class_weights, torch.Tensor):
                ce_kwargs["weight"] = self.class_weights
            ce_loss = nn.functional.cross_entropy(
                ce_logits.view(-1, self.num_labels),
                labels.view(-1),
                **ce_kwargs,
            )
            if self.use_affix_head and affix_logits is not None:
                safe = labels.clamp_min(0)
                affix_targets = self.affix_target_lut[safe]
                affix_targets = torch.where(labels.eq(-100), torch.full_like(affix_targets, -100), affix_targets)
                affix_loss = nn.functional.cross_entropy(
                    affix_logits.view(-1, 5), affix_targets.view(-1), ignore_index=-100
                )
                ce_loss = ce_loss + affix_loss
            if self.crf is not None and attention_mask is not None and self.crf_loss_weight > 0:
                # Replace IGNORE_INDEX positions in labels with 0 so gather doesn't OOB —
                # those positions are zeroed by the mask anyway.
                crf_reduction = "per_token" if self.crf_normalization == "per_token" else "mean"
                if self.crf_fp32:
                    # Disable autocast for the CRF forward and upcast emissions + mask to fp32: the
                    # transition-table forward pass operates on masked-`-inf` entries that lose
                    # precision under bf16's 7-bit mantissa, and fp32's 23 bits have enough
                    # headroom for `logsumexp` over -1e30 sentinels.
                    device_type = logits.device.type
                    with torch.autocast(device_type=device_type, enabled=False):
                        emissions_fp32 = logits.float()
                        crf_mask = attention_mask.to(emissions_fp32.dtype)
                        crf_loss = self.crf(
                            emissions=emissions_fp32,
                            tags=labels.clamp(min=0),
                            mask=crf_mask,
                            reduction=crf_reduction,
                        )
                else:
                    crf_mask = attention_mask.to(logits.dtype)
                    crf_loss = self.crf(
                        emissions=logits,
                        tags=labels.clamp(min=0),
                        mask=crf_mask,
                        reduction=crf_reduction,
                    )
                # Cast crf_loss back to ce_loss's dtype before summing, so the optimizer sees one
                # consistent loss tensor regardless of which path produced it.
                loss = ce_loss + self.crf_loss_weight * crf_loss.to(ce_loss.dtype)
            else:
                loss = ce_loss

        return self._add_auxiliary_losses(
            loss,
            hidden=hidden,
            labels=labels,
            attention_mask=attention_mask,
            locale_ids=locale_ids,
            locale_logits=locale_logits,
        )

    def _add_auxiliary_losses(
        self,
        loss: torch.Tensor | None,
        *,
        hidden: torch.Tensor,
        labels: torch.Tensor | None,
        attention_mask: torch.Tensor | None,
        locale_ids: torch.Tensor | None,
        locale_logits: torch.Tensor | None,
    ) -> tuple[torch.Tensor | None, torch.Tensor | None]:
        """The three auxiliary terms, each switched on by its own flag and scaled by its own weight.

        Each shapes the shared encoder without appearing in the inference graph: the locale CE
        supervises the pooled representation the FiLM conditioning reads, the span-boundary BCE
        pressures span edges, and the semi-Markov NLL scores segmentations. `loss` arrives as the
        supervised term or None, and each addition guards its own empty-batch case — an all-ignored
        batch contributes no term rather than dividing by zero.

        Returns the accumulated loss and the span scores, which are an output rather than a term.
        """
        # Auxiliary locale cross-entropy, in fp32: supervises the locale head against the row's
        # country so the pooled representation (and therefore the FiLM conditioning) actually
        # encodes "which country". Rows whose country is unmapped carry IGNORE_INDEX and are
        # skipped; an all-ignored batch contributes no term rather than 0/0 → NaN.
        if (
            self.use_locale_conditioning
            and locale_logits is not None
            and locale_ids is not None
            and self.locale_loss_weight > 0
            and bool((locale_ids != IGNORE_INDEX).any())
        ):
            locale_ce = nn.functional.cross_entropy(
                locale_logits.float(),
                locale_ids,
                ignore_index=IGNORE_INDEX,
            )
            locale_term = self.locale_loss_weight * locale_ce
            loss = locale_term if loss is None else loss + locale_term.to(loss.dtype)

        # Span-boundary auxiliary loss: per-token BCE on span start (B-*) and END (entity token whose
        # successor doesn't continue it), supervised from the BIO labels. Computed in fp32 because a
        # structural/transition-style leg gets fp32 headroom, and BCE over masked positions is cheap.
        # Masked to real, non-ignore tokens; a batch with no valid position contributes no term
        # rather than 0/0 → NaN.
        if (
            self.use_span_boundary_head
            and labels is not None
            and attention_mask is not None
            and self.span_boundary_loss_weight > 0
        ):
            valid = attention_mask.bool() & labels.ne(-100)
            if bool(valid.any()):
                safe = labels.clamp_min(0)
                is_b = self.bio_is_begin[safe]
                is_i = self.bio_is_inside[safe]
                in_entity = is_b | is_i
                # END: an entity token whose next token is not an I- continuation (BIO-valid → same entity).
                next_is_i = torch.zeros_like(is_i)
                next_is_i[:, :-1] = is_i[:, 1:]
                start_tgt = is_b.float()
                end_tgt = (in_entity & ~next_is_i).float()
                # Run the head in the ambient (autocast) dtype, then upcast the logits to fp32 for a
                # stable BCE. Upcasting `h` before the matmul instead would clash with the bf16 head
                # weights (mat1/mat2 dtype).
                sb_logits = self.span_boundary_head(hidden)
                targets = torch.stack([start_tgt, end_tgt], dim=-1)
                per_pos = nn.functional.binary_cross_entropy_with_logits(
                    sb_logits.float(), targets, reduction="none"
                ).mean(dim=-1)
                sb_loss = per_pos[valid].mean()
                sb_term = self.span_boundary_loss_weight * sb_loss
                loss = sb_term if loss is None else loss + sb_term.to(loss.dtype)

        # The semi-Markov span loss, fp32 throughout (the DP owns its upcast). Rows whose gold
        # segmentation exceeds `max_span` are skipped rather than truncated — a truncated gold
        # teaches a wrong boundary.
        span_scores_out: torch.Tensor | None = None

        if self.use_span_scorer and self.span_scorer is not None:
            span_scores_out = self.span_scorer(hidden)

            if labels is not None and attention_mask is not None and self.span_loss_weight > 0:
                assert self.semi_crf is not None  # nosec B101 — type narrowing. built in __init__ when use_span_scorer
                lengths = attention_mask.sum(dim=1).long()
                row_idxs: list[int] = []
                segs: list[list[tuple[int, int, int]]] = []

                for b_i in range(labels.shape[0]):
                    n = int(lengths[b_i])
                    row_segs, representable = gold_segments(labels[b_i, :n].tolist(), self.span_scorer.max_span)

                    if representable and row_segs:
                        row_idxs.append(b_i)
                        segs.append(row_segs)

                if row_idxs:
                    idx = torch.tensor(row_idxs, device=span_scores_out.device)
                    span_nll = self.semi_crf.nll(
                        span_scores_out.index_select(0, idx), segs, lengths.index_select(0, idx)
                    ).mean()
                    span_term = self.span_loss_weight * span_nll
                    loss = span_term if loss is None else loss + span_term.to(loss.dtype)

        return loss, span_scores_out
