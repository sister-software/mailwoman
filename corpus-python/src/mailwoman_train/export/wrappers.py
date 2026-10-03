"""One wrapper per input combination the exporter can trace.

Two constraints produce this file. The ONNX exporter prefers plain-tensor outputs, so the model's
output object is unwrapped into a tensor or tuple. The dynamo tracer wants a FIXED
POSITIONAL SIGNATURE, so a single wrapper taking `**kwargs` cannot stand in for all of them — the
combination a model was trained with decides which signature its graph gets.

Every wrapper uses the same output assembly method. The method always returns `logits`.
It returns `locale_logits` when the model has the self-conditioning head. It returns
`span_scores` when the model has the span scorer. Trace-time reads of the plain Python flags
ensure the graph contains only the outputs supported by that model.

`tests/mailwoman_train/export/test_channel_export.py` exports through every one of these.
"""

from __future__ import annotations

from typing import Any

import torch
from torch import nn


class PlainOutputs(nn.Module):
    """Wrap the model and convert its output object into the structure the exporter traces."""

    def __init__(self, inner: nn.Module) -> None:
        super().__init__()
        self.inner = inner
        self.with_locale = False
        self.with_spans = False
        self.with_address_system = False

    def _outputs(self, out: Any) -> Any:
        outs = [out.logits]
        if self.with_locale:
            outs.append(out.locale_logits)
        if self.with_spans:
            outs.append(out.span_scores)
        if self.with_address_system:
            outs.append(out.address_system_logits)
        return tuple(outs) if len(outs) > 1 else outs[0]


class LogitsOnly(PlainOutputs):
    """The channel-free SentencePiece graph: ids and a mask."""

    def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor) -> Any:
        return self._outputs(self.inner(input_ids=input_ids, attention_mask=attention_mask))


class LogitsOnlyChar(PlainOutputs):
    """The char path: no `input_ids` at all, because the model's forward never reads them."""

    def forward(self, char_ids: torch.Tensor, attention_mask: torch.Tensor) -> Any:
        return self._outputs(self.inner(char_ids=char_ids, attention_mask=attention_mask))


class LogitsOnlyAnchor(PlainOutputs):
    def forward(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
        anchor_features: torch.Tensor,
        anchor_confidence: torch.Tensor,
    ) -> Any:
        return self._outputs(
            self.inner(
                input_ids=input_ids,
                attention_mask=attention_mask,
                anchor_features=anchor_features,
                anchor_confidence=anchor_confidence,
            )
        )


class LogitsOnlyGaz(PlainOutputs):
    def forward(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
        gazetteer_features: torch.Tensor,
        gazetteer_confidence: torch.Tensor,
    ) -> Any:
        return self._outputs(
            self.inner(
                input_ids=input_ids,
                attention_mask=attention_mask,
                gazetteer_features=gazetteer_features,
                gazetteer_confidence=gazetteer_confidence,
            )
        )


class LogitsOnlyAnchorGaz(PlainOutputs):
    def forward(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
        anchor_features: torch.Tensor,
        anchor_confidence: torch.Tensor,
        gazetteer_features: torch.Tensor,
        gazetteer_confidence: torch.Tensor,
    ) -> Any:
        return self._outputs(
            self.inner(
                input_ids=input_ids,
                attention_mask=attention_mask,
                anchor_features=anchor_features,
                anchor_confidence=anchor_confidence,
                gazetteer_features=gazetteer_features,
                gazetteer_confidence=gazetteer_confidence,
            )
        )


class LogitsOnlyAnchorGazCountry(PlainOutputs):
    def forward(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
        anchor_features: torch.Tensor,
        anchor_confidence: torch.Tensor,
        gazetteer_features: torch.Tensor,
        gazetteer_confidence: torch.Tensor,
        country_features: torch.Tensor,
        country_confidence: torch.Tensor,
    ) -> Any:
        return self._outputs(
            self.inner(
                input_ids=input_ids,
                attention_mask=attention_mask,
                anchor_features=anchor_features,
                anchor_confidence=anchor_confidence,
                gazetteer_features=gazetteer_features,
                gazetteer_confidence=gazetteer_confidence,
                country_features=country_features,
                country_confidence=country_confidence,
            )
        )


class LogitsOnlyBundle(PlainOutputs):
    """The full evidence-bundle export (Option-A Phase 2): anchor + gazetteer + country +
    street_type + locality_surface — the only supported bundle combination (the v3.18-confirmed
    recipe's ship shape)."""

    def forward(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
        anchor_features: torch.Tensor,
        anchor_confidence: torch.Tensor,
        gazetteer_features: torch.Tensor,
        gazetteer_confidence: torch.Tensor,
        country_features: torch.Tensor,
        country_confidence: torch.Tensor,
        street_type_features: torch.Tensor,
        street_type_confidence: torch.Tensor,
        locality_surface_features: torch.Tensor,
        locality_surface_confidence: torch.Tensor,
    ) -> Any:
        return self._outputs(
            self.inner(
                input_ids=input_ids,
                attention_mask=attention_mask,
                anchor_features=anchor_features,
                anchor_confidence=anchor_confidence,
                gazetteer_features=gazetteer_features,
                gazetteer_confidence=gazetteer_confidence,
                country_features=country_features,
                country_confidence=country_confidence,
                street_type_features=street_type_features,
                street_type_confidence=street_type_confidence,
                locality_surface_features=locality_surface_features,
                locality_surface_confidence=locality_surface_confidence,
            )
        )


class LogitsOnlyBundleHinted(PlainOutputs):
    """The evidence bundle plus `locale_hint`, one address-system id per row.

    The id `num_address_systems` means "no hint", which is what a runtime without one feeds.
    """

    def forward(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
        anchor_features: torch.Tensor,
        anchor_confidence: torch.Tensor,
        gazetteer_features: torch.Tensor,
        gazetteer_confidence: torch.Tensor,
        country_features: torch.Tensor,
        country_confidence: torch.Tensor,
        street_type_features: torch.Tensor,
        street_type_confidence: torch.Tensor,
        locality_surface_features: torch.Tensor,
        locality_surface_confidence: torch.Tensor,
        locale_hint: torch.Tensor,
    ) -> Any:
        return self._outputs(
            self.inner(
                input_ids=input_ids,
                attention_mask=attention_mask,
                anchor_features=anchor_features,
                anchor_confidence=anchor_confidence,
                gazetteer_features=gazetteer_features,
                gazetteer_confidence=gazetteer_confidence,
                country_features=country_features,
                country_confidence=country_confidence,
                street_type_features=street_type_features,
                street_type_confidence=street_type_confidence,
                locality_surface_features=locality_surface_features,
                locality_surface_confidence=locality_surface_confidence,
                locale_hint_ids=locale_hint,
            )
        )
