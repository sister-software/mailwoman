"""Encoding one corpus row into the tensors a training step reads.

This is where the soft-feed channels are assembled. Each channel is optional and absent by
default, so a row encoded without one is byte-identical to what the pre-channel recipe produced.
Every channel projects onto the SAME pieces the labels do, and pads to the same width.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from ..features.country_lexicon import COUNTRY_FEATURE_DIM, realign_country_to_pieces
from ..features.gazetteer_anchor import realign_gazetteer_to_pieces, suppress_gazetteer_near_postcode
from ..labels import IGNORE_INDEX, LABEL_TO_ID
from .anchors import (
    ANCHOR_FEATURE_DIM,
    realign_anchor_to_pieces,
    realign_anchor_to_pieces_from_spans,
    realign_anchor_to_pieces_shaped,
)
from .spans import realign_labels_to_pieces, realign_spans_to_pieces


def encode_row(
    tokenizer: Any,
    raw: str,
    tokens: Sequence[str],
    labels: Sequence[str],
    max_length: int,
    anchor_lookup: dict[str, tuple[dict[str, float], float, float]] | None = None,
    anchor_paint_mode: str = "gold",
    gazetteer_lexicon: Any = None,
    gazetteer_choreography: bool = False,
    country_lexicon: Any = None,
    street_type_lexicon: Any = None,
    locality_surface_lexicon: Any = None,
    span_starts: Sequence[int] | None = None,
    span_ends: Sequence[int] | None = None,
    span_tags: Sequence[str] | None = None,
) -> dict[str, list[Any]]:
    """Encode a single row into ``input_ids`` + ``attention_mask`` + ``label_ids``.

    Truncates to ``max_length`` SP pieces. Pads to ``max_length`` with the SP ``pad_id`` and
    fills the label tail with ``IGNORE_INDEX`` so cross-entropy ignores the padding.

    **Label source** (#519, the v0.5.0 char-offset migration): when the row carries the span
    triple (``span_starts``/``span_ends``/``span_tags``), the per-char label array is built FROM
    THE SPANS and the token-quantized path is skipped — intra-span punctuation pieces get the
    span's label, which the token path structurally cannot express. Rows without spans use the
    legacy ``tokens``/``labels`` path unchanged, so the loader reads both corpus generations
    during the transition; the token path is deleted once v0.5.0 lands. This is one storage
    format change in flight, not a permanent dual-format fork.

    When ``anchor_lookup`` is supplied (the postcode-anchor pilot, #239/#240), also returns
    ``anchor_features`` ``(max_length, ANCHOR_FEATURE_DIM)`` and ``anchor_confidence``
    ``(max_length,)``, projected onto the SAME pieces as the labels (so a postcode anchor lands on
    exactly its sub-tokens) and zero-padded. Absent → those keys are omitted (back-compat). The
    anchor follows the label source: spans present → the postcode range comes off the spans.

    When ``gazetteer_lexicon`` is supplied (the gazetteer anchor, #464), also returns
    ``gazetteer_features`` ``(max_length, lexicon.feature_dim)`` and ``gazetteer_confidence``
    ``(max_length,)`` — candidate-tag-set clues painted from the RAW SURFACE only (never labels;
    identical computation at train and inference, and identical under both label sources).
    Absent → omitted (back-compat).
    """
    has_spans = span_starts is not None or span_ends is not None or span_tags is not None
    if has_spans and (span_starts is None or span_ends is None or span_tags is None):
        raise ValueError(
            "encode_row: span_starts/span_ends/span_tags must be supplied together "
            f"(got starts={span_starts is not None} ends={span_ends is not None} "
            f"tags={span_tags is not None})"
        )
    spans = tokenizer.encode_with_spans(raw)
    if has_spans:
        # The partial-triple raise above guarantees all three are present; local fallbacks
        # narrow for mypy without a stripped-under -O assert.
        starts = span_starts if span_starts is not None else ()
        ends = span_ends if span_ends is not None else ()
        tags = span_tags if span_tags is not None else ()
        bio_labels = realign_spans_to_pieces(raw, starts, ends, tags, spans)
    else:
        bio_labels = realign_labels_to_pieces(raw, tokens, labels, spans)
    ids = [s.piece_id for s in spans][:max_length]
    label_ids = [LABEL_TO_ID[label] for label in bio_labels][:max_length]
    attention = [1] * len(ids)
    pad_needed = max_length - len(ids)
    if pad_needed > 0:
        ids.extend([tokenizer.pad_id] * pad_needed)
        attention.extend([0] * pad_needed)
        label_ids.extend([IGNORE_INDEX] * pad_needed)
    out: dict[str, list[Any]] = {"input_ids": ids, "attention_mask": attention, "labels": label_ids}

    if anchor_lookup is not None:
        if anchor_paint_mode == "shaped":
            # #220/#723: paint on postcode-SHAPED spans (mirror inference's neural/postcode-anchor.ts),
            # NOT gold postcode labels — so the model trains on the anchor firing on house-numbers-that-
            # look-like-ZIPs and learns to override it. Ignores tokens/labels/spans (shape from raw text).
            feats, confs = realign_anchor_to_pieces_shaped(raw, list(spans), anchor_lookup)
        elif has_spans:
            starts = span_starts if span_starts is not None else ()
            ends = span_ends if span_ends is not None else ()
            tags = span_tags if span_tags is not None else ()
            feats, confs = realign_anchor_to_pieces_from_spans(raw, starts, ends, tags, list(spans), anchor_lookup)
        else:
            feats, confs = realign_anchor_to_pieces(raw, tokens, labels, list(spans), anchor_lookup)
        feats = feats[:max_length]
        confs = confs[:max_length]
        zero = [0.0] * ANCHOR_FEATURE_DIM
        if pad_needed > 0:
            feats = feats + [zero] * pad_needed
            confs = confs + [0.0] * pad_needed
        out["anchor_features"] = feats
        out["anchor_confidence"] = confs

    if gazetteer_lexicon is not None:
        gfeats, gconfs = realign_gazetteer_to_pieces(raw, list(spans), gazetteer_lexicon)
        gfeats = gfeats[:max_length]
        gconfs = gconfs[:max_length]
        # Train-time channel choreography (#464): zero the clue adjacent to postcode-anchor hits so
        # the model never learns the biased region->postcode CRF transition. Keyed off the SAME anchor
        # confidence inference uses (consistent train/inference). No-op without the anchor channel.
        if gazetteer_choreography and "anchor_confidence" in out:
            gfeats, gconfs = suppress_gazetteer_near_postcode(
                gfeats, gconfs, out["anchor_confidence"][: len(gconfs)], gazetteer_lexicon.feature_dim
            )
        gzero = [0.0] * gazetteer_lexicon.feature_dim
        if pad_needed > 0:
            gfeats = gfeats + [gzero] * pad_needed
            gconfs = gconfs + [0.0] * pad_needed
        out["gazetteer_features"] = gfeats
        out["gazetteer_confidence"] = gconfs

    if country_lexicon is not None:
        # Country-lexicon channel (#1104): per-piece [country_surface, country_ambiguous] painted from
        # the RAW SURFACE only (never labels; identical at train + inference). Independent of the
        # near-postcode gazetteer choreography — a trailing "…12345 USA" keeps its country clue.
        cfeats, cconfs = realign_country_to_pieces(raw, list(spans), country_lexicon)
        cfeats = cfeats[:max_length]
        cconfs = cconfs[:max_length]
        czero = [0.0] * COUNTRY_FEATURE_DIM
        if pad_needed > 0:
            cfeats = cfeats + [czero] * pad_needed
            cconfs = cconfs + [0.0] * pad_needed
        out["country_features"] = cfeats
        out["country_confidence"] = cconfs

    if street_type_lexicon is not None:
        # Street-type channel (P-A / Option A): per-piece street_type clue painted from the RAW SURFACE
        # by the codex street-type lexicon. Same schema as the gazetteer lexicon, so it reuses the same
        # generic realign. Independent of the near-postcode choreography (a street-type word is a street
        # fact wherever it sits). Positive-evidence-only — absence paints zero.
        sfeats, sconfs = realign_gazetteer_to_pieces(raw, list(spans), street_type_lexicon)
        sfeats = sfeats[:max_length]
        sconfs = sconfs[:max_length]
        szero = [0.0] * street_type_lexicon.feature_dim
        if pad_needed > 0:
            sfeats = sfeats + [szero] * pad_needed
            sconfs = sconfs + [0.0] * pad_needed
        out["street_type_features"] = sfeats
        out["street_type_confidence"] = sconfs

    if locality_surface_lexicon is not None:
        # Locality-surface channel (v3.16.0 evidence bundle): per-piece [locality, locality_homograph]
        # painted from the RAW SURFACE. Same lexicon schema as the gazetteer → same generic realign.
        lfeats, lconfs = realign_gazetteer_to_pieces(raw, list(spans), locality_surface_lexicon)
        lfeats = lfeats[:max_length]
        lconfs = lconfs[:max_length]
        lzero = [0.0] * locality_surface_lexicon.feature_dim
        if pad_needed > 0:
            lfeats = lfeats + [lzero] * pad_needed
            lconfs = lconfs + [0.0] * pad_needed
        out["locality_surface_features"] = lfeats
        out["locality_surface_confidence"] = lconfs
    return out
