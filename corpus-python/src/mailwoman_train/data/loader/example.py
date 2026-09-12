"""What one encoded row carries into a batch."""

from __future__ import annotations

from dataclasses import dataclass

from ...labels import IGNORE_INDEX


@dataclass
class EncodedExample:
    input_ids: list[int]
    attention_mask: list[int]
    labels: list[int]
    # PR3 self-conditioning: the row's locale class id (from its ``country``), or IGNORE_INDEX
    # when unmapped. The aux locale head's per-row target. Defaults to IGNORE_INDEX so encoders
    # built without locale conditioning are unaffected.
    locale_id: int = IGNORE_INDEX
    # Postcode-anchor channel (#239/#240). Per-piece ``(max_length, ANCHOR_FEATURE_DIM)`` features +
    # ``(max_length,)`` confidence, or None when no anchor lookup is configured (back-compat).
    anchor_features: list[list[float]] | None = None
    anchor_confidence: list[float] | None = None
    # Gazetteer-anchor channel (#464). Per-piece ``(max_length, lexicon.feature_dim)`` candidate-
    # tag-set clues + ``(max_length,)`` confidence, or None when no lexicon is configured.
    gazetteer_features: list[list[float]] | None = None
    gazetteer_confidence: list[float] | None = None
    # Country-lexicon channel (#1104). Per-piece ``(max_length, 2)`` [country_surface,
    # country_ambiguous] clue + ``(max_length,)`` confidence, or None when no country lexicon is set.
    country_features: list[list[float]] | None = None
    country_confidence: list[float] | None = None
    # Street-type channel (P-A / Option A). Per-piece ``(max_length, 1)`` street_type clue +
    # ``(max_length,)`` confidence, or None when no street-type lexicon is set.
    street_type_features: list[list[float]] | None = None
    street_type_confidence: list[float] | None = None
    # Locality-surface channel (v3.16.0 evidence bundle). Per-piece ``(max_length, 2)`` clue +
    # ``(max_length,)`` confidence, or None when no locality-surface lexicon is set.
    locality_surface_features: list[list[float]] | None = None
    locality_surface_confidence: list[float] | None = None
    # CharCNN input path (#825 / v8 CJK, the D1 contract). ``(max_units, max_unit_width)`` char IDs,
    # or None on the SentencePiece path. When present, ``input_ids`` is a dummy all-PAD row (the
    # model's use_char_embed branch never reads it) and attention/labels are PER UNIT, not per piece.
    char_ids: list[list[int]] | None = None
