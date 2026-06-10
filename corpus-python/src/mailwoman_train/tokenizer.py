"""SentencePiece tokenizer wrapper with span info + label realignment.

The corpus parquet stores ``raw`` plus a whitespace-tokenized ``tokens`` list and a parallel
``labels`` list (BIO over those whitespace tokens). The neural model is trained over
SentencePiece sub-tokens, which are *finer-grained* than the whitespace tokens. This module:

1. Loads the SentencePiece model trained in Phase 1 (``/data/models/tokenizer/v0.1.0/``).
2. Encodes ``raw`` into pieces *with byte-level offsets*.
3. Realigns the whitespace-token BIO labels onto the SP pieces via character spans.

The byte-offset hook is ``EncodeAsImmutableProto`` — the only SentencePiece API that exposes
``piece.begin`` / ``piece.end`` (in bytes). We convert those to char offsets via a precomputed
byte→char index map so multibyte UTF-8 (accents, CJK) round-trips correctly.

Why not just use a HuggingFace fast tokenizer? Two reasons:

- We don't have a ``tokenizer.json`` for this SP model — only ``tokenizer.model``. Converting
  is doable (PreTrainedTokenizerFast supports loading SP via slow→fast bridge) but adds a
  fragile build step. Going direct is simpler and the offsets are exact.
- We need labels aligned at *training-data prep* time, not inference time. The training loop
  consumes pre-aligned ``(input_ids, label_ids)`` tensors, so we don't need a HF tokenizer
  object at all once labels are baked.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import sentencepiece as spm  # type: ignore[import-not-found]

from .labels import IGNORE_INDEX, LABEL_TO_ID, LOCALE_TO_ID, NUM_LOCALES, collapse_label

# Anchor feature width: a uniform country posterior over the locale set + a 2-d normalized centroid.
# Must equal the model's ``anchor_feature_dim`` default (NUM_LOCALES + 2) — single source of truth.
ANCHOR_FEATURE_DIM = NUM_LOCALES + 2


@dataclass(frozen=True)
class PieceSpan:
    piece: str
    piece_id: int
    # Character offsets into the original ``raw`` string (inclusive begin, exclusive end).
    char_begin: int
    char_end: int


class Tokenizer:
    """SentencePiece tokenizer + sub-token char-span realignment helpers."""

    def __init__(self, model_path: Path | str) -> None:
        self.model_path = Path(model_path)
        self.sp = spm.SentencePieceProcessor(model_file=str(self.model_path))

    @property
    def vocab_size(self) -> int:
        return int(self.sp.get_piece_size())

    @property
    def pad_id(self) -> int:
        return int(self.sp.pad_id())

    @property
    def unk_id(self) -> int:
        return int(self.sp.unk_id())

    @property
    def bos_id(self) -> int:
        return int(self.sp.bos_id())

    @property
    def eos_id(self) -> int:
        return int(self.sp.eos_id())

    def encode_with_spans(self, raw: str) -> list[PieceSpan]:
        """Encode raw text and return one ``PieceSpan`` per sub-token with char offsets."""
        proto = self.sp.encode(raw, out_type="immutable_proto")
        # Build a byte→char index for the original raw string so we can map proto byte offsets.
        raw_bytes = raw.encode("utf-8")
        # ``byte_to_char[i]`` is the char index of the codepoint that owns byte ``i`` (start byte).
        byte_to_char = [0] * (len(raw_bytes) + 1)
        ci = 0
        bi = 0
        for ch in raw:
            ch_bytes = ch.encode("utf-8")
            for offset in range(len(ch_bytes)):
                byte_to_char[bi + offset] = ci
            bi += len(ch_bytes)
            ci += 1
        byte_to_char[bi] = ci

        out: list[PieceSpan] = []
        for piece in proto.pieces:
            begin = byte_to_char[piece.begin]
            end = byte_to_char[piece.end] if piece.end <= len(raw_bytes) else len(raw)
            out.append(
                PieceSpan(
                    piece=piece.piece,
                    piece_id=piece.id,
                    char_begin=begin,
                    char_end=end,
                )
            )
        return out


def whitespace_spans(raw: str, tokens: Sequence[str]) -> list[tuple[int, int]]:
    """Return the (char_begin, char_end) span of each whitespace token in ``raw``.

    Scans left-to-right; for each token, finds it at-or-after the previous end. The corpus
    tokens come from ``packages/corpus/src/tokenize.ts`` (whitespace split + Unicode-aware),
    so the surface forms are guaranteed to be substrings of ``raw`` in order.
    """
    spans: list[tuple[int, int]] = []
    cursor = 0
    for tok in tokens:
        idx = raw.find(tok, cursor)
        if idx < 0:
            # Should not happen if the corpus invariant holds; raise so callers see corruption.
            raise ValueError(
                f"token {tok!r} not found in raw starting from offset {cursor}: {raw!r}"
            )
        end = idx + len(tok)
        spans.append((idx, end))
        cursor = end
    return spans


def char_label_array(
    raw: str,
    tokens: Sequence[str],
    labels: Sequence[str],
) -> list[str]:
    """Build a per-character BIO label array of length ``len(raw)``.

    Whitespace gaps between whitespace-tokens get ``O``. Each character inside a whitespace
    token inherits the token's label *as-is* — meaning every char of a ``B-region`` token gets
    ``B-region`` (we re-flip B/I on the SP-piece pass).
    """
    if len(tokens) != len(labels):
        raise ValueError(f"tokens/labels length mismatch: {len(tokens)} vs {len(labels)}")
    out = ["O"] * len(raw)
    for (begin, end), label in zip(whitespace_spans(raw, tokens), labels):
        for i in range(begin, end):
            out[i] = label
    return out


def realign_labels_to_pieces(
    raw: str,
    tokens: Sequence[str],
    labels: Sequence[str],
    pieces: Iterable[PieceSpan],
) -> list[str]:
    """Project the whitespace-token BIO labels onto SP pieces.

    Each SP piece gets the label of the first non-whitespace char it covers; B/I semantics
    are preserved: only the leading piece of an entity gets ``B-``, subsequent pieces in the
    same contiguous entity span get ``I-``.
    """
    char_labels = char_label_array(raw, tokens, labels)
    out: list[str] = []
    prev_tag: str | None = None
    for piece in pieces:
        # Walk to the first non-whitespace char this piece covers.
        first_label = "O"
        for i in range(piece.char_begin, piece.char_end):
            if i < len(raw) and not raw[i].isspace():
                first_label = char_labels[i] if i < len(char_labels) else "O"
                break
        # Collapse to Stage 1 (anything outside the coarse set becomes O).
        first_label = collapse_label(first_label)
        if first_label == "O":
            out.append("O")
            prev_tag = None
            continue
        prefix, tag = first_label.split("-", 1)
        # Flip B→I when this piece continues the same entity as the previous piece.
        if prev_tag == tag:
            out.append(f"I-{tag}")
        else:
            out.append(f"B-{tag}")
        prev_tag = tag
    return out


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
    anchor_lookup: "dict[str, tuple[dict[str, float], float, float]]",
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
            postcode = raw[begin:end].replace(" ", "").upper()
            hit = anchor_lookup.get(postcode)
            if hit is not None:
                posterior, lat, lon = hit
                feat = anchor_feature_vector(posterior, lat, lon)
                for c in range(begin, end):
                    char_feat[c] = feat
                    char_conf[c] = 1.0
            i = j
        else:
            i += 1

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


def encode_row(
    tokenizer: Tokenizer,
    raw: str,
    tokens: Sequence[str],
    labels: Sequence[str],
    max_length: int,
    anchor_lookup: "dict[str, tuple[dict[str, float], float, float]] | None" = None,
    gazetteer_lexicon=None,
    gazetteer_choreography: bool = False,
) -> dict[str, list]:
    """Encode a single row into ``input_ids`` + ``attention_mask`` + ``label_ids``.

    Truncates to ``max_length`` SP pieces. Pads to ``max_length`` with the SP ``pad_id`` and
    fills the label tail with ``IGNORE_INDEX`` so cross-entropy ignores the padding.

    When ``anchor_lookup`` is supplied (the postcode-anchor pilot, #239/#240), also returns
    ``anchor_features`` ``(max_length, ANCHOR_FEATURE_DIM)`` and ``anchor_confidence``
    ``(max_length,)``, projected onto the SAME pieces as the labels (so a postcode anchor lands on
    exactly its sub-tokens) and zero-padded. Absent → those keys are omitted (back-compat).

    When ``gazetteer_lexicon`` is supplied (the gazetteer anchor, #464), also returns
    ``gazetteer_features`` ``(max_length, lexicon.feature_dim)`` and ``gazetteer_confidence``
    ``(max_length,)`` — candidate-tag-set clues painted from the RAW SURFACE only (never labels;
    identical computation at train and inference). Absent → omitted (back-compat).
    """
    spans = tokenizer.encode_with_spans(raw)
    bio_labels = realign_labels_to_pieces(raw, tokens, labels, spans)
    ids = [s.piece_id for s in spans][:max_length]
    label_ids = [LABEL_TO_ID[label] for label in bio_labels][:max_length]
    attention = [1] * len(ids)
    pad_needed = max_length - len(ids)
    if pad_needed > 0:
        ids.extend([tokenizer.pad_id] * pad_needed)
        attention.extend([0] * pad_needed)
        label_ids.extend([IGNORE_INDEX] * pad_needed)
    out: dict[str, list] = {"input_ids": ids, "attention_mask": attention, "labels": label_ids}

    if anchor_lookup is not None:
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
        # Local import keeps tokenizer.py import-light for consumers that never use the anchor.
        from .gazetteer_anchor import realign_gazetteer_to_pieces

        gfeats, gconfs = realign_gazetteer_to_pieces(raw, list(spans), gazetteer_lexicon)
        gfeats = gfeats[:max_length]
        gconfs = gconfs[:max_length]
        # Train-time channel choreography (#464): zero the clue adjacent to postcode-anchor hits so
        # the model never learns the biased region->postcode CRF transition. Keyed off the SAME anchor
        # confidence inference uses (consistent train/inference). No-op without the anchor channel.
        if gazetteer_choreography and "anchor_confidence" in out:
            from .gazetteer_anchor import suppress_gazetteer_near_postcode

            gfeats, gconfs = suppress_gazetteer_near_postcode(
                gfeats, gconfs, out["anchor_confidence"][: len(gconfs)], gazetteer_lexicon.feature_dim
            )
        gzero = [0.0] * gazetteer_lexicon.feature_dim
        if pad_needed > 0:
            gfeats = gfeats + [gzero] * pad_needed
            gconfs = gconfs + [0.0] * pad_needed
        out["gazetteer_features"] = gfeats
        out["gazetteer_confidence"] = gconfs
    return out
