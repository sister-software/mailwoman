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

#: A row's char-offset span triple, once it is known to be whole.
SpanTriple = tuple[Sequence[int], Sequence[int], Sequence[str]]


def require_whole_span_triple(
    span_starts: Sequence[int] | None,
    span_ends: Sequence[int] | None,
    span_tags: Sequence[str] | None,
) -> SpanTriple | None:
    """The span triple when the row carries one, `None` when it carries none, RAISE in between.

    A partial triple is a corpus writer that emitted two of three columns. Falling back to the
    token path there would encode the row against labels the writer had already replaced, and the
    result trains without complaint.
    """
    present = [part is not None for part in (span_starts, span_ends, span_tags)]
    if not any(present):
        return None
    if not all(present):
        raise ValueError(
            "encode_row: span_starts/span_ends/span_tags must be supplied together "
            f"(got starts={present[0]} ends={present[1]} tags={present[2]})"
        )
    return (span_starts or (), span_ends or (), span_tags or ())


def fit_channel(
    painted: tuple[list[list[float]], list[float]],
    *,
    max_length: int,
    pad_needed: int,
    feature_dim: int,
) -> tuple[list[list[float]], list[float]]:
    """Truncate a painted channel to `max_length` and zero-pad it to the width the labels use.

    Every channel lands on the SAME pieces the labels do, so it must end the same width. A channel
    padded to a different one produces a tensor the collate cannot stack, which surfaces as a shape
    error somewhere else entirely.
    """
    feats, confs = painted
    feats = feats[:max_length]
    confs = confs[:max_length]
    if pad_needed > 0:
        feats = feats + [[0.0] * feature_dim] * pad_needed
        confs = confs + [0.0] * pad_needed
    return feats, confs


def paint_anchor(
    raw: str,
    tokens: Sequence[str],
    labels: Sequence[str],
    spans: Sequence[Any],
    anchor_lookup: dict[str, tuple[dict[str, float], float, float]],
    *,
    paint_mode: str,
    triple: SpanTriple | None,
) -> tuple[list[list[float]], list[float]]:
    """Paint the postcode anchor, from whichever source this row and mode name.

    `"shaped"` paints on postcode-SHAPED spans rather than gold postcode labels (#220/#723),
    mirroring inference's `neural/postcode-anchor.ts` — so the model trains on the anchor firing on
    house-numbers-that-look-like-ZIPs and learns to override it. It reads the raw text alone and
    ignores tokens, labels and spans. The other two modes follow the label source: a row with a
    span triple takes the postcode range off the spans, a row without it off the tokens.
    """
    if paint_mode == "shaped":
        return realign_anchor_to_pieces_shaped(raw, list(spans), anchor_lookup)
    if triple is not None:
        return realign_anchor_to_pieces_from_spans(raw, *triple, list(spans), anchor_lookup)
    return realign_anchor_to_pieces(raw, tokens, labels, list(spans), anchor_lookup)


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
    triple = require_whole_span_triple(span_starts, span_ends, span_tags)
    spans = tokenizer.encode_with_spans(raw)
    if triple is not None:
        bio_labels = realign_spans_to_pieces(raw, *triple, spans)
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

    def put(name: str, painted: tuple[list[list[float]], list[float]], feature_dim: int) -> None:
        feats, confs = fit_channel(painted, max_length=max_length, pad_needed=pad_needed, feature_dim=feature_dim)
        out[f"{name}_features"] = feats
        out[f"{name}_confidence"] = confs

    if anchor_lookup is not None:
        put(
            "anchor",
            paint_anchor(
                raw,
                tokens,
                labels,
                spans,
                anchor_lookup,
                paint_mode=anchor_paint_mode,
                triple=triple,
            ),
            ANCHOR_FEATURE_DIM,
        )

    if gazetteer_lexicon is not None:
        gfeats, gconfs = realign_gazetteer_to_pieces(raw, list(spans), gazetteer_lexicon)
        # Train-time channel choreography (#464): zero the clue adjacent to postcode-anchor hits so
        # the model never learns the biased region->postcode CRF transition. Keyed off the SAME anchor
        # confidence inference uses (consistent train/inference), which is why this block runs AFTER the
        # anchor's and reads the confidence out of `out`. No-op without the anchor channel.
        if gazetteer_choreography and "anchor_confidence" in out:
            gfeats, gconfs = suppress_gazetteer_near_postcode(
                gfeats, gconfs, out["anchor_confidence"][: len(gconfs)], gazetteer_lexicon.feature_dim
            )
        put("gazetteer", (gfeats, gconfs), gazetteer_lexicon.feature_dim)

    if country_lexicon is not None:
        # Country-lexicon channel (#1104): per-piece [country_surface, country_ambiguous] painted from
        # the RAW SURFACE only (never labels; identical at train + inference). Independent of the
        # near-postcode gazetteer choreography — a trailing "…12345 USA" keeps its country clue.
        put("country", realign_country_to_pieces(raw, list(spans), country_lexicon), COUNTRY_FEATURE_DIM)

    if street_type_lexicon is not None:
        # Street-type channel (P-A / Option A): per-piece street_type clue painted from the RAW SURFACE
        # by the codex street-type lexicon. Same schema as the gazetteer lexicon, so it reuses the same
        # generic realign. Independent of the near-postcode choreography (a street-type word is a street
        # fact wherever it sits). Positive-evidence-only — absence paints zero.
        painted = realign_gazetteer_to_pieces(raw, list(spans), street_type_lexicon)
        put("street_type", painted, street_type_lexicon.feature_dim)

    if locality_surface_lexicon is not None:
        # Locality-surface channel (v3.16.0 evidence bundle): per-piece [locality, locality_homograph]
        # painted from the RAW SURFACE. Same lexicon schema as the gazetteer → same generic realign.
        painted = realign_gazetteer_to_pieces(raw, list(spans), locality_surface_lexicon)
        put("locality_surface", painted, locality_surface_lexicon.feature_dim)
    return out
