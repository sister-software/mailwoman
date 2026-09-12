"""Reading tag sequences out of the logits.

`forward` answers logits; these two answer tags. They are the only inference paths that consult
the CRF, and the only ones that trim each row to its mask length, so a caller gets one list per
row with no padding in it.
"""

from __future__ import annotations

import torch

from ..crf import TopKPath
from .state import CoarseEncoderState


class CoarseEncoderDecode(CoarseEncoderState):
    """The tag-sequence half of `MailwomanCoarseEncoder`."""

    @torch.no_grad()
    def predict(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
        phrase_features: torch.Tensor | None = None,
    ) -> list[list[int]]:
        """Best-path tag IDs per row. Returns variable-length lists (mask-trimmed).

        Uses CRF Viterbi when the layer is present; falls back to per-token argmax
        otherwise (the v0.2.0 behavior — kept for ablation / pre-CRF checkpoints).
        """
        out = self.forward(
            input_ids=input_ids,
            attention_mask=attention_mask,
            phrase_features=phrase_features,
        )
        if self.crf is not None:
            return self.crf.viterbi_decode(out.logits, attention_mask.to(out.logits.dtype))
        # Argmax fallback. Trim per row to mask length.
        argmax_ids = out.logits.argmax(dim=-1)
        results: list[list[int]] = []
        for b in range(argmax_ids.size(0)):
            length = int(attention_mask[b].sum().item())
            results.append(argmax_ids[b, :length].tolist())
        return results

    @torch.no_grad()
    def predict_top_k(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
        k: int = 5,
        phrase_features: torch.Tensor | None = None,
    ) -> list[list[TopKPath]]:
        """Top-K tag sequences per row with calibrated log-prob scores.

        v0.5.0 thread C: this is what Stage 5 reconcile (Thread D) consumes. Each row
        gets up to ``k`` ``TopKPath`` items, sorted by score descending. Padding is
        trimmed from each path's ``sequence``. Only works when the encoder was built with
        ``use_crf=True`` — argmax-only encoders have no notion of path probability.
        """
        if self.crf is None:
            raise RuntimeError(
                "predict_top_k requires a CRF decoder; this encoder was built with "
                "use_crf=False. Either rebuild with use_crf=True or use predict()."
            )
        out = self.forward(
            input_ids=input_ids,
            attention_mask=attention_mask,
            phrase_features=phrase_features,
        )
        return self.crf.top_k_decode(out.logits, attention_mask.to(out.logits.dtype), k=k)
