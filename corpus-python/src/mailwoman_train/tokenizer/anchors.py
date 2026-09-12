"""Projecting the postcode-anchor channel onto SentencePiece pieces.

Three paint paths — gold labels, gold char-offset spans, and shape detection over the raw text —
share one lookup normalization (`_paint_anchor_chars`) and one char-to-piece projection
(`_project_anchor_chars_to_pieces`). They can therefore differ in WHERE they paint and never in
what they paint or how it lands on a piece.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from ..labels import LOCALE_TO_ID, NUM_LOCALES
from ..types import PieceSpan
from .spans import whitespace_spans

# Anchor feature width: a uniform country posterior over the locale set + a 2-d normalized centroid.
# Must equal the model's ``anchor_feature_dim`` default (NUM_LOCALES + 2) — single source of truth.
ANCHOR_FEATURE_DIM = NUM_LOCALES + 2

# A GB unit postcode in the space-stripped key form the anchor lookup is keyed by (``SW1A2AA``); the
# inward half is always the trailing three characters, so the outward district is the rest. Mirrors
# ``neural/anchor-inference.ts``'s ``GB_UNIT_KEY`` / ``GB_INWARD_LENGTH``.
_GB_UNIT_KEY = re.compile(r"^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$")
_GB_INWARD_LENGTH = 3


def anchor_feature_vector(posterior: dict[str, float], lat: float, lon: float) -> list[float]:
    """Build the fixed-width anchor feature vector: a uniform country posterior over the locale set
    (0 for countries outside it, renormalized over the in-set mass) + a normalized centroid
    (lat/90, lon/180 ∈ [-1, 1]). Width = ANCHOR_FEATURE_DIM."""
    vec = [0.0] * NUM_LOCALES
    total = 0.0
    for country, weight in posterior.items():
        idx = LOCALE_TO_ID.get(country.strip().upper())
        if idx is not None:
            vec[idx] = float(weight)
            total += float(weight)
    if total > 0:
        vec = [v / total for v in vec]
    vec.append(max(-1.0, min(1.0, lat / 90.0)))
    vec.append(max(-1.0, min(1.0, lon / 180.0)))
    return vec


def realign_anchor_to_pieces(
    raw: str,
    tokens: Sequence[str],
    labels: Sequence[str],
    pieces: Sequence[PieceSpan],
    anchor_lookup: dict[str, tuple[dict[str, float], float, float]],
) -> tuple[list[list[float]], list[float]]:
    """Project gold postcode-span anchor features onto SP pieces (de-risk pilot #239/#240).

    Mirrors {@linkcode realign_labels_to_pieces} EXACTLY — same char→piece projection (each piece
    inherits the value of the first non-whitespace char it covers) — so the anchor lands on precisely
    the sub-tokens the postcode labels do. That char-based reuse is what guarantees the alignment can't
    drift (the off-by-one DeepSeek flagged as the silent run-killer).

    Gold-span: the postcode span is read from the row's own ``B/I-postcode`` labels. Each contiguous
    postcode entity's surface is normalized and looked up in ``anchor_lookup`` (postcode →
    ({country: weight}, lat, lon)); a hit yields a confidence-1.0 anchor on those chars, a miss yields
    no anchor (confidence 0). Returns ``(features[n_pieces][ANCHOR_FEATURE_DIM], confidence[n_pieces])``.
    """
    zero = [0.0] * ANCHOR_FEATURE_DIM
    # Per-char anchor: feature vector + confidence for chars inside a looked-up postcode entity.
    char_feat: list[list[float]] = [zero] * len(raw)
    char_conf: list[float] = [0.0] * len(raw)
    spans = whitespace_spans(raw, tokens)
    i = 0
    while i < len(labels):
        if labels[i].endswith("-postcode") and labels[i].startswith("B"):
            # Gather this contiguous postcode entity (B then any I-postcode).
            j = i + 1
            while j < len(labels) and labels[j] == "I-postcode":
                j += 1
            begin = spans[i][0]
            end = spans[j - 1][1]
            _paint_anchor_chars(raw, begin, end, anchor_lookup, char_feat, char_conf)
            i = j
        else:
            i += 1

    return _project_anchor_chars_to_pieces(raw, char_feat, char_conf, pieces)


def realign_anchor_to_pieces_from_spans(
    raw: str,
    span_starts: Sequence[int],
    span_ends: Sequence[int],
    span_tags: Sequence[str],
    pieces: Sequence[PieceSpan],
    anchor_lookup: dict[str, tuple[dict[str, float], float, float]],
) -> tuple[list[list[float]], list[float]]:
    """Spans-native sibling of ``realign_anchor_to_pieces`` (#519, the v0.5.0 path).

    The postcode entity's char range comes straight off the row's char-offset spans (``span_tags ==
    "postcode"``) instead of being reconstructed from token labels + ``whitespace_spans``; lookup
    normalization and the char→piece projection are SHARED with the token path, so the channel
    tensor is bit-identical on rows where the postcode span equals the token-quantized range
    (i.e. every row without intra-postcode punctuation).
    """
    zero = [0.0] * ANCHOR_FEATURE_DIM
    char_feat: list[list[float]] = [zero] * len(raw)
    char_conf: list[float] = [0.0] * len(raw)
    for start, end, tag in zip(span_starts, span_ends, span_tags, strict=True):
        if tag != "postcode":
            continue
        _paint_anchor_chars(raw, start, end, anchor_lookup, char_feat, char_conf)
    return _project_anchor_chars_to_pieces(raw, char_feat, char_conf, pieces)


def _paint_anchor_chars(
    raw: str,
    begin: int,
    end: int,
    anchor_lookup: dict[str, tuple[dict[str, float], float, float]],
    char_feat: list[list[float]],
    char_conf: list[float],
) -> None:
    """Look up the postcode surface at ``raw[begin:end]`` and paint its chars on a hit.

    Shared by both anchor paths — one normalization (space-stripped, uppercased), one painting
    rule, so token-era and span-era rows cannot diverge here.

    GB OUTWARD FALLBACK (2026-08-05). A unit postcode that misses retries its outward district
    (``SW1A 2AA`` -> ``SW1A``) and paints the WHOLE unit span from it, mirroring
    ``neural/anchor-inference.ts``'s ``spanMode: "shaped"`` exactly. It earns its keep on real
    slices: against the v2 lookup, ``synth-gb-v1`` misses 217 spans in 200,000 rows (retired unit
    codes — Code-Point Open is a 2026-05 snapshot, the tuples are older), and 215 of those 217 have
    a live outward district. INERT for every lookup shipped before that date: they hold five-digit
    keys only, and a five-digit key's outward slice is two digits, which is not a key in any of
    them (and the shape guard rejects it first).
    """
    postcode = raw[begin:end].replace(" ", "").upper()
    hit = anchor_lookup.get(postcode)
    if hit is None and _GB_UNIT_KEY.match(postcode):
        hit = anchor_lookup.get(postcode[:-_GB_INWARD_LENGTH])
    if hit is None:
        return
    posterior, lat, lon = hit
    feat = anchor_feature_vector(posterior, lat, lon)
    for c in range(begin, end):
        char_feat[c] = feat
        char_conf[c] = 1.0


def _project_anchor_chars_to_pieces(
    raw: str,
    char_feat: Sequence[list[float]],
    char_conf: Sequence[float],
    pieces: Sequence[PieceSpan],
) -> tuple[list[list[float]], list[float]]:
    """Char→piece projection for the anchor channel — first non-whitespace char wins.

    Mirrors ``project_char_labels_to_pieces`` exactly (the off-by-one DeepSeek flagged as the
    silent run-killer); shared by both anchor paths.
    """
    zero = [0.0] * ANCHOR_FEATURE_DIM
    feats: list[list[float]] = []
    confs: list[float] = []
    for piece in pieces:
        chosen_feat = zero
        chosen_conf = 0.0
        for c in range(piece.char_begin, piece.char_end):
            if c < len(raw) and not raw[c].isspace():
                chosen_feat = char_feat[c]
                chosen_conf = char_conf[c]
                break
        feats.append(chosen_feat)
        confs.append(chosen_conf)
    return feats, confs


def realign_anchor_to_pieces_shaped(
    raw: str,
    pieces: Sequence[PieceSpan],
    anchor_lookup: dict[str, tuple[dict[str, float], float, float]],
) -> tuple[list[list[float]], list[float]]:
    """Shape-detected sibling of ``realign_anchor_to_pieces`` (#220/#723, ``anchor_paint_mode="shaped"``).

    Paints the anchor on postcode-SHAPED spans detected over the RAW text (``postcode_shapes.collect_matches``
    — the train-side mirror of inference's ``neural/postcode-anchor.ts``), NOT on gold ``postcode`` labels.
    So at TRAIN the anchor fires on the SAME spans inference paints — INCLUDING a house-number-that-looks-
    like-a-ZIP ("12345 Main St") — which the gold paths never did (the #723 train/inference mismatch that
    let the anchor pollute leading-5-digit house numbers). A shaped span that MISSES ``anchor_lookup`` paints
    nothing (confidence 0), exactly like inference. Lookup normalization + char->piece projection are SHARED
    with the gold paths via ``_paint_anchor_chars`` / ``_project_anchor_chars_to_pieces`` — so this can only
    differ from gold in WHERE it paints, never in WHAT it paints or HOW it lands on pieces. (The rare DE
    ``D-`` / Dutch-spaced shapes inherit the gold path's space-strip+upper normalization — a pre-existing
    minor gap, not introduced here; the dominant NUM5/ZIP4/EU-numeric shapes normalize identically.)
    """
    from ..features.postcode_shapes import collect_matches

    zero = [0.0] * ANCHOR_FEATURE_DIM
    char_feat: list[list[float]] = [zero] * len(raw)
    char_conf: list[float] = [0.0] * len(raw)
    for m in collect_matches(raw):
        _paint_anchor_chars(raw, m.start, m.end, anchor_lookup, char_feat, char_conf)
    return _project_anchor_chars_to_pieces(raw, char_feat, char_conf, pieces)
