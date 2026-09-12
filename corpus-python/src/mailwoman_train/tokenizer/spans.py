"""Turning a row's labels into a per-piece BIO array.

Two label sources reach the same projection. A pre-v0.5.0 row carries whitespace tokens with a
parallel BIO list; a v0.5.0 row carries char-offset spans. Both build a per-character array and
both hand it to `project_char_labels_to_pieces`, so the two generations cannot drift in how a
label lands on a piece — only in which characters carry one.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from ..labels import collapse_label
from ..types import PieceSpan


def whitespace_spans(raw: str, tokens: Sequence[str]) -> list[tuple[int, int]]:
    """Return the (char_begin, char_end) span of each whitespace token in ``raw``.

    Scans left-to-right; for each token, finds it at-or-after the previous end. The corpus
    tokens come from ``packages/corpus/lib/tokenize.ts`` (whitespace split + Unicode-aware),
    so the surface forms are guaranteed to be substrings of ``raw`` in order.
    """
    spans: list[tuple[int, int]] = []
    cursor = 0
    for tok in tokens:
        idx = raw.find(tok, cursor)
        if idx < 0:
            # Should not happen if the corpus invariant holds; raise so callers see corruption.
            raise ValueError(f"token {tok!r} not found in raw starting from offset {cursor}: {raw!r}")
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
    for (begin, end), label in zip(whitespace_spans(raw, tokens), labels, strict=True):
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
        raise ValueError(f"span arrays length mismatch: starts={n} ends={len(span_ends)} tags={len(span_tags)}")
    out = ["O"] * len(raw)
    prev_start = -1
    prev_end = 0
    for start, end, tag in zip(span_starts, span_ends, span_tags, strict=True):
        if not (0 <= start < end <= len(raw)):
            raise ValueError(f"span out of bounds: {tag}@[{start}, {end}) over raw of length {len(raw)}: {raw!r}")
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
