"""Projecting the postcode-anchor channel onto SentencePiece pieces, whose three paint paths
share one lookup normalization and one char-to-piece projection.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from ..labels import LOCALE_TO_ID, NUM_LOCALES
from ..types import PieceSpan
from .spans import whitespace_spans

# Must equal the model's ``anchor_feature_dim`` default (NUM_LOCALES + 2).
ANCHOR_FEATURE_DIM = NUM_LOCALES + 2

# A GB unit postcode in the space-stripped key form the lookup is keyed by (``SW1A2AA``); the inward
# half is always the trailing three characters. Mirrors ``neural/anchor-inference.ts``.
_GB_UNIT_KEY = re.compile(r"^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$")
_GB_INWARD_LENGTH = 3


def anchor_feature_vector(posterior: dict[str, float], lat: float, lon: float) -> list[float]:
    """Build the fixed-width anchor feature vector: a uniform country posterior over the locale set
    (renormalized over the in-set mass) plus a normalized centroid (lat/90, lon/180 ∈ [-1, 1])."""
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
    """Project gold postcode-span anchor features onto SP pieces.

    Mirrors ``realign_labels_to_pieces`` exactly (each piece inherits the first non-whitespace char
    it covers), so the anchor lands on the sub-tokens the postcode labels do. A contiguous
    ``B/I-postcode`` entity is normalized and looked up in ``anchor_lookup``; a hit yields a
    confidence-1.0 anchor on those chars, a miss yields no anchor. Returns
    ``(features[n_pieces][ANCHOR_FEATURE_DIM], confidence[n_pieces])``.
    """
    zero = [0.0] * ANCHOR_FEATURE_DIM
    char_feat: list[list[float]] = [zero] * len(raw)
    char_conf: list[float] = [0.0] * len(raw)
    spans = whitespace_spans(raw, tokens)
    i = 0
    while i < len(labels):
        if labels[i].endswith("-postcode") and labels[i].startswith("B"):
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
    """Spans-native sibling of ``realign_anchor_to_pieces``.

    The postcode entity's char range comes off the row's char-offset spans (``span_tags ==
    "postcode"``) instead of token labels plus ``whitespace_spans``; lookup normalization and the
    char→piece projection are shared with the token path, so the channel tensor is bit-identical
    where the span equals the token-quantized range.
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

    One normalization (space-stripped, uppercased) and one painting rule, shared by both anchor
    paths so token-era and span-era rows cannot diverge. A GB unit postcode that misses retries
    its outward district (``SW1A 2AA`` -> ``SW1A``) and paints the whole unit span from it,
    mirroring ``neural/anchor-inference.ts``'s ``spanMode: "shaped"``.
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
    """Char→piece projection for the anchor channel: the first non-whitespace char wins.

    Mirrors ``project_char_labels_to_pieces`` and is shared by both anchor paths.
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
    """Shape-detected sibling of ``realign_anchor_to_pieces`` (``anchor_paint_mode="shaped"``).

    Paints on postcode-shaped spans detected over the raw text (``postcode_shapes.collect_matches``,
    the train-side mirror of inference's ``neural/postcode-anchor.ts``) rather than gold ``postcode``
    labels, so at train the anchor fires on the same spans inference paints, including a
    house-number-that-looks-like-a-ZIP. A shaped span that misses ``anchor_lookup`` paints no
    anchor, exactly like inference. Lookup normalization and char→piece projection are shared with
    the gold paths, so this can differ from gold only in where it paints; the rare DE ``D-`` and
    Dutch-spaced shapes inherit the gold path's space-strip+upper normalization.
    """
    from ..features.postcode_shapes import collect_matches

    zero = [0.0] * ANCHOR_FEATURE_DIM
    char_feat: list[list[float]] = [zero] * len(raw)
    char_conf: list[float] = [0.0] * len(raw)
    for m in collect_matches(raw):
        _paint_anchor_chars(raw, m.start, m.end, anchor_lookup, char_feat, char_conf)
    return _project_anchor_chars_to_pieces(raw, char_feat, char_conf, pieces)
