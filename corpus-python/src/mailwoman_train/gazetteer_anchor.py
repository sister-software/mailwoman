"""Gazetteer-anchor input features (knowledge-ladder rung 3.2; #464).

Per-token candidate-tag-set clues from the codex-generated lexicon
(``scripts/build-gazetteer-anchor-lexicon.mjs`` → ``data/gazetteer/anchor-lexicon-v1.json``):
a multi-hot row per SentencePiece piece over ``slots`` (country/region/po_box/cedex/homograph)
plus a confidence channel (1.0 where any bit fires). The model conditions on the clue and still
decides every tag — model-first, never an override (see
docs/articles/plan/reference/closed-vocab-fields-model-first.mdx).

CRITICALLY, and unlike the postcode anchor: features are computed from the RAW SURFACE ONLY —
never from gold labels — so the exact same computation runs at train and inference time (no leak,
no skew). The matching rules live in the lexicon JSON (``rules``) and are mirrored verbatim here
and in the TS inference matcher; the JSON is the single source both consumers load, so the two
implementations cannot drift (the PLACETYPE_ORDER lesson).

Char→piece projection mirrors ``realign_anchor_to_pieces`` EXACTLY (each piece inherits the value
of the first non-whitespace char it covers) so the clue lands on precisely the sub-tokens the
labels do.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Sequence

from .tokenizer import PieceSpan

# Leading/trailing strip: chars that are not Unicode letters/digits. Mirrors the builder's
# /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu — Python's \w with re.UNICODE covers [\p{L}\p{N}_]; underscore
# never borders our surfaces, so strip on "not alphanumeric" via str.isalnum per char.
_WS_RE = re.compile(r"\S+")


def _strip_word(word: str) -> str:
    """word_norm for a single word: strip leading/trailing non-letter/digit chars (keep internal)."""
    start, end = 0, len(word)
    while start < end and not word[start].isalnum():
        start += 1
    while end > start and not word[end - 1].isalnum():
        end -= 1
    return word[start:end]


@dataclass(frozen=True)
class GazetteerLexicon:
    """The loaded lexicon: two entry maps + the layout the feature rows follow."""

    feature_dim: int
    slots: tuple[str, ...]
    bits: dict[str, int]
    max_ngram: int
    entries: dict[str, int]  # word_norm lowercased → bitmask (case-insensitive)
    code_entries: dict[str, int]  # word_norm UPPERCASED → bitmask (exact, 1-gram only)


def load_gazetteer_lexicon(path: str) -> GazetteerLexicon:
    """Load the codex-generated lexicon JSON once at loader init."""
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    return GazetteerLexicon(
        feature_dim=int(raw["feature_dim"]),
        slots=tuple(raw["slots"]),
        bits={k: int(v) for k, v in raw["bits"].items()},
        max_ngram=int(raw["max_ngram"]),
        entries={k: int(v) for k, v in raw["entries"].items()},
        code_entries={k: int(v) for k, v in raw["code_entries"].items()},
    )


def _bits_to_row(bits: int, lexicon: GazetteerLexicon) -> list[float]:
    return [1.0 if bits & lexicon.bits[slot] else 0.0 for slot in lexicon.slots]


def gazetteer_char_paint(raw: str, lexicon: GazetteerLexicon) -> tuple[list[int], int]:
    """Scan the raw surface and paint each char with its candidate-tag bitmask.

    Longest-first n-gram scan over whitespace words, left to right, non-overlapping (the lexicon's
    ``rules.scan``). Returns ``(char_bits[len(raw)], n_matches)``.
    """
    char_bits = [0] * len(raw)
    words = [(m.start(), m.end(), m.group()) for m in _WS_RE.finditer(raw)]
    # Per-word normalized forms + their char extents AFTER stripping (paint only the kept chars).
    # Stripping removes only leading/trailing chars, so the kept run is contiguous in the original.
    norm_words: list[tuple[int, int, str]] = []
    for start, _end, surface in words:
        stripped = _strip_word(surface)
        if not stripped:
            norm_words.append((start, start, ""))
            continue
        head = 0
        while head < len(surface) and not surface[head].isalnum():
            head += 1
        norm_words.append((start + head, start + head + len(stripped), stripped))

    n_matches = 0
    i = 0
    while i < len(norm_words):
        if not norm_words[i][2]:
            i += 1
            continue
        matched_n = 0
        matched_bits = 0
        for n in range(min(lexicon.max_ngram, len(norm_words) - i), 0, -1):
            parts = [norm_words[k][2] for k in range(i, i + n)]
            if any(not p for p in parts):
                continue
            key = " ".join(parts).lower()
            bits = lexicon.entries.get(key, 0)
            if n == 1:
                # code_entries is CASE-SENSITIVE: the surface must already BE uppercase ("IN" the
                # state code, not "in" the English word). Keys are uppercase; compare the raw
                # word_norm without folding case.
                bits |= lexicon.code_entries.get(parts[0], 0)
            if bits:
                matched_n, matched_bits = n, bits
                break
        if matched_n:
            begin = norm_words[i][0]
            end = norm_words[i + matched_n - 1][1]
            for c in range(begin, min(end, len(raw))):
                char_bits[c] = matched_bits
            n_matches += 1
            i += matched_n
        else:
            i += 1
    return char_bits, n_matches


def realign_gazetteer_to_pieces(
    raw: str,
    pieces: Sequence[PieceSpan],
    lexicon: GazetteerLexicon,
) -> tuple[list[list[float]], list[float]]:
    """Project the char-painted candidate-tag bits onto SP pieces.

    Mirrors ``realign_anchor_to_pieces`` exactly: each piece inherits the bits of the first
    non-whitespace char it covers. Returns ``(features[n_pieces][feature_dim], confidence[n_pieces])``
    with confidence 1.0 wherever any bit fires.
    """
    char_bits, _ = gazetteer_char_paint(raw, lexicon)
    zero = [0.0] * lexicon.feature_dim
    feats: list[list[float]] = []
    confs: list[float] = []
    for piece in pieces:
        bits = 0
        for c in range(piece.char_begin, piece.char_end):
            if c < len(raw) and not raw[c].isspace():
                bits = char_bits[c]
                break
        feats.append(_bits_to_row(bits, lexicon) if bits else zero)
        confs.append(1.0 if bits else 0.0)
    return feats, confs
