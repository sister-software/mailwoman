"""SentencePiece tokenizer wrapper with span info + label realignment.

The corpus parquet stores ``raw`` plus a whitespace-tokenized ``tokens`` list and a parallel
``labels`` list (BIO over those whitespace tokens). As of the v0.5.0 char-offset migration
(#519) rows additionally carry ``span_starts[]``/``span_ends[]``/``span_tags[]`` — char ranges
over ``raw`` (sorted, non-overlapping) — which become the label source of truth; when present,
``encode_row`` builds the per-char label array directly from the spans and skips the
token-quantized projection (the path that made supervision punctuation-mute). The neural model
is trained over SentencePiece sub-tokens, which are *finer-grained* than the whitespace tokens.
This module:

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


def char_label_array_from_spans(
    raw: str,
    span_starts: Sequence[int],
    span_ends: Sequence[int],
    span_tags: Sequence[str],
) -> list[str]:
    """Build the per-character BIO label array directly from char-offset spans (#519, v0.5.0).

    The v0.5.0 corpus stores labels as the parallel triple ``span_starts[]/span_ends[]/span_tags[]``
    — char ranges over ``raw``, [start, end) exclusive-end. This is the spans-native sibling of
    ``char_label_array``: no whitespace-token indirection, so intra-span punctuation chars (the
    ``P.O.`` periods) carry the span's label instead of falling to ``O``.

    Validates the triple's manifest invariants loudly (equal lengths, sorted ascending by start,
    non-overlapping, in-bounds) — a violation means a corrupt corpus row, never something to paper
    over silently.
    """
    n = len(span_starts)
    if len(span_ends) != n or len(span_tags) != n:
        raise ValueError(
            f"span arrays length mismatch: starts={n} ends={len(span_ends)} tags={len(span_tags)}"
        )
    out = ["O"] * len(raw)
    prev_start = -1
    prev_end = 0
    for start, end, tag in zip(span_starts, span_ends, span_tags):
        if not (0 <= start < end <= len(raw)):
            raise ValueError(
                f"span out of bounds: {tag}@[{start}, {end}) over raw of length {len(raw)}: {raw!r}"
            )
        if start < prev_start:
            raise ValueError(f"spans not sorted: {tag}@[{start}, {end}) after [{prev_start}, {prev_end})")
        if start < prev_end:
            raise ValueError(f"spans overlap: {tag}@[{start}, {end}) overlaps [{prev_start}, {prev_end})")
        out[start] = f"B-{tag}"
        for i in range(start + 1, end):
            out[i] = f"I-{tag}"
        prev_start, prev_end = start, end
    return out


def project_char_labels_to_pieces(
    raw: str,
    char_labels: Sequence[str],
    pieces: Iterable[PieceSpan],
) -> list[str]:
    """Project a per-character BIO label array onto SP pieces.

    THE projection — both label paths (token-quantized and char-span) flow through this single
    function, so the two cannot drift. Each SP piece gets the label of the first non-whitespace
    char it covers; B/I semantics are recomputed per piece: only the leading piece of a contiguous
    entity gets ``B-``, subsequent pieces get ``I-``.
    """
    out: list[str] = []
    prev_tag: str | None = None
    for piece in pieces:
        # Walk to the first non-whitespace char this piece covers.
        first_label = "O"
        for i in range(piece.char_begin, piece.char_end):
            if i < len(raw) and not raw[i].isspace():
                first_label = char_labels[i] if i < len(char_labels) else "O"
                break
        # Collapse to the active set (anything outside it becomes O).
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


def realign_labels_to_pieces(
    raw: str,
    tokens: Sequence[str],
    labels: Sequence[str],
    pieces: Iterable[PieceSpan],
) -> list[str]:
    """Project the whitespace-token BIO labels onto SP pieces (the pre-v0.5.0 token path).

    Token-quantized: punctuation chars the corpus tokenizer dropped are ``O`` in the per-char
    array, so a piece whose first non-whitespace char is intra-span punctuation gets ``O`` — the
    structural blind spot the v0.5.0 char-span format removes. Deleted once v0.5.0 lands.
    """
    return project_char_labels_to_pieces(raw, char_label_array(raw, tokens, labels), pieces)


def realign_spans_to_pieces(
    raw: str,
    span_starts: Sequence[int],
    span_ends: Sequence[int],
    span_tags: Sequence[str],
    pieces: Iterable[PieceSpan],
) -> list[str]:
    """Project char-offset label spans onto SP pieces (#519, the v0.5.0 path).

    Same projection as ``realign_labels_to_pieces`` (shared ``project_char_labels_to_pieces``);
    only the per-char array construction differs — built FROM the spans, so every covered char
    (punctuation included) carries its span's label.
    """
    return project_char_labels_to_pieces(
        raw, char_label_array_from_spans(raw, span_starts, span_ends, span_tags), pieces
    )


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
    anchor_lookup: "dict[str, tuple[dict[str, float], float, float]]",
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
    for start, end, tag in zip(span_starts, span_ends, span_tags):
        if tag != "postcode":
            continue
        _paint_anchor_chars(raw, start, end, anchor_lookup, char_feat, char_conf)
    return _project_anchor_chars_to_pieces(raw, char_feat, char_conf, pieces)


def _paint_anchor_chars(
    raw: str,
    begin: int,
    end: int,
    anchor_lookup: "dict[str, tuple[dict[str, float], float, float]]",
    char_feat: list[list[float]],
    char_conf: list[float],
) -> None:
    """Look up the postcode surface at ``raw[begin:end]`` and paint its chars on a hit.

    Shared by both anchor paths — one normalization (space-stripped, uppercased), one painting
    rule, so token-era and span-era rows cannot diverge here.
    """
    postcode = raw[begin:end].replace(" ", "").upper()
    hit = anchor_lookup.get(postcode)
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
    anchor_lookup: "dict[str, tuple[dict[str, float], float, float]]",
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
    from .postcode_shapes import collect_matches

    zero = [0.0] * ANCHOR_FEATURE_DIM
    char_feat: list[list[float]] = [zero] * len(raw)
    char_conf: list[float] = [0.0] * len(raw)
    for m in collect_matches(raw):
        _paint_anchor_chars(raw, m.start, m.end, anchor_lookup, char_feat, char_conf)
    return _project_anchor_chars_to_pieces(raw, char_feat, char_conf, pieces)


def encode_row(
    tokenizer: Tokenizer,
    raw: str,
    tokens: Sequence[str],
    labels: Sequence[str],
    max_length: int,
    anchor_lookup: "dict[str, tuple[dict[str, float], float, float]] | None" = None,
    anchor_paint_mode: str = "gold",
    gazetteer_lexicon=None,
    gazetteer_choreography: bool = False,
    span_starts: Sequence[int] | None = None,
    span_ends: Sequence[int] | None = None,
    span_tags: Sequence[str] | None = None,
) -> dict[str, list]:
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
        bio_labels = realign_spans_to_pieces(raw, span_starts, span_ends, span_tags, spans)
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
    out: dict[str, list] = {"input_ids": ids, "attention_mask": attention, "labels": label_ids}

    if anchor_lookup is not None:
        if anchor_paint_mode == "shaped":
            # #220/#723: paint on postcode-SHAPED spans (mirror inference's neural/postcode-anchor.ts),
            # NOT gold postcode labels — so the model trains on the anchor firing on house-numbers-that-
            # look-like-ZIPs and learns to override it. Ignores tokens/labels/spans (shape from raw text).
            feats, confs = realign_anchor_to_pieces_shaped(raw, list(spans), anchor_lookup)
        elif has_spans:
            feats, confs = realign_anchor_to_pieces_from_spans(
                raw, span_starts, span_ends, span_tags, list(spans), anchor_lookup
            )
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
