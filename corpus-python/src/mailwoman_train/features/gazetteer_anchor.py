from __future__ import annotations

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass

from ..types import PieceSpan

_WS_RE = re.compile(r"\S+")


def _strip_word(word: str) -> str:
    start, end = 0, len(word)
    while start < end and not word[start].isalnum():
        start += 1
    while end > start and not word[end - 1].isalnum():
        end -= 1
    return word[start:end]


@dataclass(frozen=True)
class GazetteerLexicon:
    feature_dim: int
    slots: tuple[str, ...]
    bits: dict[str, int]
    max_ngram: int
    entries: dict[str, int]
    code_entries: dict[str, int]

    digit_guard: bool = False


def load_gazetteer_lexicon(path: str) -> GazetteerLexicon:
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    return GazetteerLexicon(
        feature_dim=int(raw["feature_dim"]),
        slots=tuple(raw["slots"]),
        bits={k: int(v) for k, v in raw["bits"].items()},
        max_ngram=int(raw["max_ngram"]),
        entries={k: int(v) for k, v in raw["entries"].items()},
        code_entries={k: int(v) for k, v in raw["code_entries"].items()},
        digit_guard=bool(raw.get("rules", {}).get("digit_guard", False)),
    )


def _bits_to_row(bits: int, lexicon: GazetteerLexicon) -> list[float]:
    return [1.0 if bits & lexicon.bits[slot] else 0.0 for slot in lexicon.slots]


def gazetteer_char_paint(raw: str, lexicon: GazetteerLexicon) -> tuple[list[int], int]:
    char_bits = [0] * len(raw)
    words = [(m.start(), m.end(), m.group()) for m in _WS_RE.finditer(raw)]

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
                bits |= lexicon.code_entries.get(parts[0], 0)
            if bits:
                matched_n, matched_bits = n, bits
                break
        if matched_n:
            if lexicon.digit_guard and _digit_adjacent(norm_words, i, matched_n):
                i += matched_n
                continue
            begin = norm_words[i][0]
            end = norm_words[i + matched_n - 1][1]
            for c in range(begin, min(end, len(raw))):
                char_bits[c] = matched_bits
            n_matches += 1
            i += matched_n
        else:
            i += 1
    return char_bits, n_matches


def _has_decimal(word: str) -> bool:
    return any(ch.isdecimal() for ch in word)


def _digit_adjacent(norm_words: list[tuple[int, int, str]], i: int, matched_n: int) -> bool:
    for k in range(i, i + matched_n):
        if _has_decimal(norm_words[k][2]):
            return True
    k = i - 1
    while k >= 0 and not norm_words[k][2]:
        k -= 1
    if k >= 0 and _has_decimal(norm_words[k][2]):
        return True
    k = i + matched_n
    while k < len(norm_words) and not norm_words[k][2]:
        k += 1
    return k < len(norm_words) and _has_decimal(norm_words[k][2])


def suppress_gazetteer_near_postcode(
    feats: list[list[float]],
    confs: list[float],
    anchor_confidence: Sequence[float],
    feature_dim: int,
    window: int = 1,
) -> tuple[list[list[float]], list[float]]:
    n = len(confs)
    suppress = [False] * n
    for i in range(n):
        if i < len(anchor_confidence) and anchor_confidence[i] > 0:
            for d in range(-window, window + 1):
                j = i + d
                if d != 0 and 0 <= j < n:
                    suppress[j] = True
    zero = [0.0] * feature_dim
    out_feats = [zero if suppress[i] else feats[i] for i in range(n)]
    out_confs = [0.0 if suppress[i] else confs[i] for i in range(n)]
    return out_feats, out_confs


def realign_gazetteer_to_pieces(
    raw: str,
    pieces: Sequence[PieceSpan],
    lexicon: GazetteerLexicon,
) -> tuple[list[list[float]], list[float]]:
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
