"""Which channels a model carries, whether that combination is exportable, and what its graph looks like.

A channel the model was TRAINED with and the graph does not carry runs OFF at inference, silently:
the runtime feeds by name, so an absent input is an absent clue, and the model reports confident
answers computed without it. That is the #566/#685 trap, and it is why the unsupported combinations
below raise instead of exporting a reduced graph.

Every feature input requests a dynamic dim 0 and dim 1 (batch, sequence) and a FIXED dim 2 — the
feature width is a property of the lexicon the channel was built from, not of the input.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import torch
from torch import nn

from .wrappers import (
    LogitsOnly,
    LogitsOnlyAnchor,
    LogitsOnlyAnchorGaz,
    LogitsOnlyAnchorGazCountry,
    LogitsOnlyBundle,
    LogitsOnlyChar,
    LogitsOnlyGaz,
    PlainOutputs,
)

BASE_DYNAMIC = {
    "input_ids": {0: "batch", 1: "sequence"},
    "attention_mask": {0: "batch", 1: "sequence"},
}

#: Every feature input is (batch, sequence, width) and every confidence is (batch, sequence).
PER_TOKEN = {0: "batch", 1: "sequence"}


@dataclass(frozen=True)
class Channels:
    """What the checkpoint carries, read off the model rather than off the config that built it."""

    anchor: bool = False
    anchor_dim: int = 0
    gazetteer: bool = False
    gazetteer_dim: int = 0
    country: bool = False
    country_dim: int = 0
    street_type: bool = False
    street_type_dim: int = 0
    locality_surface: bool = False
    locality_surface_dim: int = 0
    char: bool = False
    locale: bool = False
    spans: bool = False

    @property
    def bundle(self) -> bool:
        """Either evidence-bundle channel. The guard below is what makes 'either' mean 'both'."""
        return self.street_type or self.locality_surface


@dataclass
class ExportGraph:
    """The four things `torch.onnx.export` needs, assembled for one channel combination."""

    module: PlainOutputs
    args: tuple[Any, ...]
    input_names: list[str]
    dynamic_shapes: dict[str, dict[int, str]]
    output_names: list[str]


def detect_channels(model: nn.Module) -> Channels:
    """Read the channel flags off the model.

    Off the MODEL, not off a config: a checkpoint is resumed and re-exported long after the config
    that built it has moved on, and the graph has to match the weights.
    """
    return Channels(
        anchor=bool(getattr(model, "use_postcode_anchor", False)),
        anchor_dim=int(getattr(model, "anchor_feature_dim", 0)),
        gazetteer=bool(getattr(model, "use_gazetteer_anchor", False)),
        gazetteer_dim=int(getattr(model, "gazetteer_feature_dim", 0)),
        country=bool(getattr(model, "use_country_anchor", False)),
        country_dim=int(getattr(model, "country_feature_dim", 0)),
        street_type=bool(getattr(model, "use_street_type_anchor", False)),
        street_type_dim=int(getattr(model, "street_type_feature_dim", 0)),
        locality_surface=bool(getattr(model, "use_locality_surface_anchor", False)),
        locality_surface_dim=int(getattr(model, "locality_surface_feature_dim", 0)),
        char=bool(getattr(model, "use_char_embed", False)),
        # Locale head (#511 Tier A / conventions layer): when the model carries the PR3
        # self-conditioning head, export its pooled posterior as a SECOND output ("locale_logits",
        # shape [batch, num_locales], labels.LOCALE_COUNTRIES order). Consumers fetch outputs by
        # name, so this is backward-compatible; without it the model's address-system detection is
        # trained but UNREADABLE at inference — the gap the 2026-06-10 FR digit-split regression
        # exposed.
        locale=getattr(model, "locale_head", None) is not None,
        # #727 stage-2: export the span scorer's (B, S, L, T) scores as a NAMED output. Appending is
        # backward-compatible — a runtime that never asks for `span_scores` pays nothing (ORT prunes
        # the unfetched branch). The Phase-3 JS decoder + the semi-crf-transitions.json sidecar
        # (package_weights.export_semi_crf_transitions) consume it.
        spans=bool(getattr(model, "use_span_scorer", False)),
    )


def check_exportable(channels: Channels) -> None:
    """Refuse a combination whose graph would drop a trained channel."""
    # The country channel ships on top of anchor+gaz (the production ship-config). Exporting it in any
    # other combination is unsupported — a country-trained model whose ONNX lacked the country inputs
    # would silently run country-OFF (the #566/#685 OOD trap), so fail loud instead.
    if channels.country and not (channels.anchor and channels.gazetteer):
        raise NotImplementedError(
            "use_country_anchor is only exportable alongside the anchor + gazetteer channels "
            "(the production ship-config); got has_anchor="
            f"{channels.anchor}, has_gaz={channels.gazetteer}, has_country={channels.country}."
        )
    # Evidence-bundle check (Option-A): the bundle exports ONLY as the full v3.18-confirmed shape —
    # BOTH channels, on top of anchor+gaz+country. Any other combination would ship a model whose
    # ONNX silently drops a trained channel (the #566/#685 OOD trap) — fail loud instead.
    if channels.bundle and not (
        channels.street_type
        and channels.locality_surface
        and channels.anchor
        and channels.gazetteer
        and channels.country
    ):
        raise NotImplementedError(
            "the evidence bundle is only exportable as BOTH channels on top of anchor+gazetteer+country "
            f"(got street_type={channels.street_type}, locality_surface={channels.locality_surface}, "
            f"anchor={channels.anchor}, gaz={channels.gazetteer}, country={channels.country})."
        )


def _channel_args(batch: int, length: int, width: int) -> tuple[torch.Tensor, torch.Tensor]:
    """One channel's (features, confidence) example pair."""
    return (
        torch.zeros((batch, length, width), dtype=torch.float32),
        torch.zeros((batch, length), dtype=torch.float32),
    )


def _named(*prefixes: str) -> list[str]:
    return [f"{prefix}_{suffix}" for prefix in prefixes for suffix in ("features", "confidence")]


def build_export_graph(
    model: nn.Module,
    channels: Channels,
    *,
    batch: int,
    max_length: int,
    pad_token_id: int,
    char_window: int | None,
) -> ExportGraph:
    """Pick the wrapper for `channels` and build the example inputs its signature takes."""
    check_exportable(channels)
    dummy_ids = torch.full((batch, max_length), pad_token_id, dtype=torch.long)
    dummy_ids[:, 0] = 1  # ensure at least one non-pad slot
    dummy_mask = torch.ones((batch, max_length), dtype=torch.long)
    anchor = _channel_args(batch, max_length, channels.anchor_dim)
    gaz = _channel_args(batch, max_length, channels.gazetteer_dim)
    country = _channel_args(batch, max_length, channels.country_dim)

    module: PlainOutputs
    if channels.char:
        if char_window is None or char_window <= 0:
            raise ValueError("a char-path model needs char_window (the config's max_unit_width) to export")
        dummy_chars = torch.zeros((batch, max_length, char_window), dtype=torch.long)
        dummy_chars[:, 0, :] = 1  # <unk>, so the first unit is a real unit rather than all padding
        module = LogitsOnlyChar(model).eval()
        args: tuple[Any, ...] = (dummy_chars, dummy_mask)
        input_names = ["char_ids", "attention_mask"]
        dynamic_shapes = {
            "char_ids": dict(PER_TOKEN),  # dim 2 (char_window) is fixed
            "attention_mask": dict(PER_TOKEN),
        }
    elif channels.bundle:
        street_type = _channel_args(batch, max_length, channels.street_type_dim)
        locality_surface = _channel_args(batch, max_length, channels.locality_surface_dim)
        module = LogitsOnlyBundle(model).eval()
        args = (dummy_ids, dummy_mask, *anchor, *gaz, *country, *street_type, *locality_surface)
        input_names = ["input_ids", "attention_mask", *_named("anchor", "gazetteer", "country")]
        input_names += _named("street_type", "locality_surface")
        dynamic_shapes = {**BASE_DYNAMIC, **{name: dict(PER_TOKEN) for name in input_names[2:]}}
    elif channels.anchor and channels.gazetteer and channels.country:
        module = LogitsOnlyAnchorGazCountry(model).eval()
        args = (dummy_ids, dummy_mask, *anchor, *gaz, *country)
        input_names = ["input_ids", "attention_mask", *_named("anchor", "gazetteer", "country")]
        dynamic_shapes = {**BASE_DYNAMIC, **{name: dict(PER_TOKEN) for name in input_names[2:]}}
    elif channels.anchor and channels.gazetteer:
        module = LogitsOnlyAnchorGaz(model).eval()
        args = (dummy_ids, dummy_mask, *anchor, *gaz)
        input_names = ["input_ids", "attention_mask", *_named("anchor", "gazetteer")]
        dynamic_shapes = {**BASE_DYNAMIC, **{name: dict(PER_TOKEN) for name in input_names[2:]}}
    elif channels.anchor:
        module = LogitsOnlyAnchor(model).eval()
        args = (dummy_ids, dummy_mask, *anchor)
        input_names = ["input_ids", "attention_mask", *_named("anchor")]
        dynamic_shapes = {**BASE_DYNAMIC, **{name: dict(PER_TOKEN) for name in input_names[2:]}}
    elif channels.gazetteer:
        module = LogitsOnlyGaz(model).eval()
        args = (dummy_ids, dummy_mask, *gaz)
        input_names = ["input_ids", "attention_mask", *_named("gazetteer")]
        dynamic_shapes = {**BASE_DYNAMIC, **{name: dict(PER_TOKEN) for name in input_names[2:]}}
    else:
        module = LogitsOnly(model).eval()
        args = (dummy_ids, dummy_mask)
        input_names = ["input_ids", "attention_mask"]
        dynamic_shapes = dict(BASE_DYNAMIC)

    module.with_locale = channels.locale
    module.with_spans = channels.spans
    output_names = ["logits"]
    if channels.locale:
        output_names.append("locale_logits")
    if channels.spans:
        output_names.append("span_scores")
    return ExportGraph(module, args, input_names, dynamic_shapes, output_names)
