"""Char-word tokenization for the CharCNN front-end (#825).

The SentencePiece path (``tokenizer.py``) fragments diacritic-heavy tokens ("Čistá" -> [▁,Č,is,t,á])
because the English-trained unigram vocab has no multi-char subwords containing diacritics — a 3.3x
fertility tax on Slavic that breaks span boundaries and geocodes to the wrong city. The CharCNN front-end
sidesteps that: tokenize into WORDS (whitespace tokens; one char per token for CJK later) and compose each
word's embedding from its CHARACTERS, so the tokenizer never gets to isolate a diacritic into its own piece.

This module is the data side of that fix:

- ``build_char_vocab`` — scan a corpus sample and assign an ID to every character seen (0 = PAD, 1 = UNK).
  A few thousand entries covers Latin+diacritics; it stays small even when CJK is added later (the char
  table is tiny vs a 48k subword vocab), which is exactly why char-composition scales to CJK where
  subword-vocab expansion does not.
- ``encode_row_charword`` — turn ``raw`` + whitespace ``tokens`` + per-token ``labels`` into the model
  inputs: a ``(S, W)`` matrix of char IDs (S = word count, W = max chars/word), an attention mask over
  words, and per-word BIO label IDs. The word-level labels come straight from the corpus's whitespace
  ``tokens``/``labels`` (already word-aligned) — no SentencePiece sub-token projection.

Deliberately minimal for the de-risk probe: no anchor / gazetteer / phrase channels (those project per
SP-piece today; the probe compares a BARE char model against a BARE SentencePiece model on the same
corpus, isolating the embedding front-end). The channels get a per-word re-alignment once the probe
confirms the fix reaches the coordinate.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Sequence
from pathlib import Path

from .labels import IGNORE_INDEX, LABEL_TO_ID, collapse_label

PAD_CHAR_ID = 0
UNK_CHAR_ID = 1


def build_char_vocab(texts: Iterable[str], min_count: int = 1) -> dict[str, int]:
    """Assign an ID to each character appearing >= ``min_count`` times. 0 = PAD, 1 = UNK, then chars.

    Deterministic: characters are sorted by codepoint so the same corpus yields the same vocab (a stable
    artifact the ONNX runtime's char map must match exactly).
    """
    counts: dict[str, int] = {}
    for t in texts:
        for ch in t:
            counts[ch] = counts.get(ch, 0) + 1
    vocab: dict[str, int] = {"<pad>": PAD_CHAR_ID, "<unk>": UNK_CHAR_ID}
    next_id = 2
    for ch in sorted(c for c, n in counts.items() if n >= min_count):
        vocab[ch] = next_id
        next_id += 1
    return vocab


def save_char_vocab(vocab: dict[str, int], path: Path | str) -> None:
    Path(path).write_text(json.dumps(vocab, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")


def load_char_vocab(path: Path | str) -> dict[str, int]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def encode_row_charword(
    raw: str,
    tokens: Sequence[str],
    labels: Sequence[str],
    char_to_id: dict[str, int],
    max_tokens: int,
    max_word_len: int,
) -> dict[str, list]:
    """Encode one row into ``char_ids`` ``(max_tokens, max_word_len)`` + ``attention_mask`` + ``labels``.

    Each whitespace token becomes one position; its characters map to char IDs (unknown -> UNK), truncated
    /padded to ``max_word_len``. The per-word BIO label is the corpus token label collapsed to the active
    set. Word count is truncated to ``max_tokens`` and padded with all-PAD word rows (masked out).
    """
    if len(tokens) != len(labels):
        raise ValueError(f"tokens/labels length mismatch: {len(tokens)} vs {len(labels)}")

    toks = list(tokens[:max_tokens])
    labs = list(labels[:max_tokens])

    char_ids: list[list[int]] = []
    label_ids: list[int] = []
    for tok, lab in zip(toks, labs, strict=True):
        row = [char_to_id.get(ch, UNK_CHAR_ID) for ch in tok[:max_word_len]]
        row.extend([PAD_CHAR_ID] * (max_word_len - len(row)))
        char_ids.append(row)
        label_ids.append(LABEL_TO_ID[collapse_label(lab)])

    attention = [1] * len(char_ids)
    pad_word = [PAD_CHAR_ID] * max_word_len
    pad_needed = max_tokens - len(char_ids)
    if pad_needed > 0:
        char_ids.extend([list(pad_word) for _ in range(pad_needed)])
        attention.extend([0] * pad_needed)
        label_ids.extend([IGNORE_INDEX] * pad_needed)

    return {"char_ids": char_ids, "attention_mask": attention, "labels": label_ids}
