"""Editing one row's text without losing what the text carried.

Every augmentation here SPLICES: it replaces a character range in ``raw`` and re-targets the token
list, the label list and the char-offset span triple to match. No augmentation rebuilds ``raw``
from the token list — a ``" ".join(tokens)`` rebuild destroys whatever the tokens do not carry
(newlines, double spaces) and re-quantizes spans to token boundaries, so a trailing comma inside a
``"123,"`` token would get absorbed into the po_box span. v0.5.0 (#519) makes that punctuation
essential, so every augmented copy keeps the source raw's characters except for the deliberate
edit (PR #534 open question 3).

**Char-offset spans** (#519, v0.5.0): rows from a v0.5.0 corpus carry
``span_starts``/``span_ends``/``span_tags`` beside tokens/labels, and every augmented COPY must
re-target them by the same splice arithmetic — offsets after the edit shift by the replacement's
length delta, a span containing the edit grows/shrinks at its end, and a span boundary falling
strictly INSIDE the edited token is impossible to re-target (the replaced surface no longer exists)
and raises loudly. Yielding a mutated raw with the source row's spans would corrupt the labels
silently. Rows without spans (frozen pre-v0.5.0 corpora) pass through the legacy token path
unchanged; a PARTIAL triple raises.
"""

from __future__ import annotations

from typing import Any, cast

from ...tokenizer import whitespace_spans

SPAN_KEYS = ("span_starts", "span_ends", "span_tags")


def row_span_triple(row: dict[str, Any]) -> tuple[list[int], list[int], list[str]] | None:
    """Return the row's char-offset span triple (#519), or None for a legacy (token-only) row.

    A PARTIAL triple — some keys present/non-null, others missing/null — is a corrupt row and
    raises loudly; it must never silently fall back to the token path (the labels it would fall
    back TO are not the labels the row was built with).
    """
    values = [row.get(k) for k in SPAN_KEYS]
    present = [v is not None for v in values]
    if not any(present):
        return None
    if not all(present):
        missing = [k for k, p in zip(SPAN_KEYS, present, strict=True) if not p]
        raise ValueError(
            f"corrupt row: partial char-offset span triple (#519) — missing {missing} (raw={row.get('raw')!r})"
        )
    starts, ends, tags = cast(tuple[list[int], list[int], list[str]], values)  # all present, verified above
    if len(starts) != len(ends) or len(starts) != len(tags):
        raise ValueError(
            f"corrupt row: span triple arrays not parallel — "
            f"starts={len(starts)} ends={len(ends)} tags={len(tags)} (raw={row.get('raw')!r})"
        )
    return starts, ends, tags


def splice_expansion(row: dict[str, Any], idx: int, expansion: str) -> dict[str, Any]:
    """Return a copy of ``row`` with token ``idx``'s surface in ``raw`` replaced by ``expansion``
    via character splicing — never a ``" ".join(tokens)`` rebuild, which would destroy whatever
    raw carries that the tokens don't (PR #534 open question 3). Tokens + labels are updated by
    the matching ``_expand_token`` arithmetic; everything else in raw (commas, dots, newlines,
    double spaces) survives verbatim.

    Char-offset spans (#519) are re-targeted by the same splice arithmetic, mirroring
    ``glue_region_postcode``: with the edit at ``[s, e)`` and ``delta = len(expansion) - (e - s)``,

    - a span entirely before the edit is untouched,
    - a span entirely after the edit shifts by ``delta``,
    - a span containing the edit keeps its start and moves its end by ``delta`` (the edit is one
      whole whitespace token, so a span covering the token shrinks/grows in place),
    - a span boundary STRICTLY INSIDE the edited token cannot be re-targeted — the surface it
      addressed no longer exists — and raises rather than guesses.
    """
    raw: str = row["raw"]
    tokens: list[str] = row["tokens"]
    labels: list[str] = row["labels"]
    s, e = whitespace_spans(raw, tokens)[idx]
    delta = len(expansion) - (e - s)
    new_tokens, new_labels = _expand_token(tokens, labels, idx, expansion)
    out = {
        **row,
        "raw": raw[:s] + expansion + raw[e:],
        "tokens": new_tokens,
        "labels": new_labels,
    }
    triple = row_span_triple(row)
    if triple is not None:
        starts, ends, tags = triple
        new_starts: list[int] = []
        new_ends: list[int] = []
        for start, end in zip(starts, ends, strict=True):
            if end <= s:
                # Entirely before the edit.
                new_starts.append(start)
                new_ends.append(end)
            elif start >= e:
                # Entirely after the edit: shift by the replacement's length delta.
                new_starts.append(start + delta)
                new_ends.append(end + delta)
            elif start <= s and end >= e:
                # Contains the edited token: the end moves with the splice.
                new_starts.append(start)
                new_ends.append(end + delta)
            else:
                raise ValueError(
                    f"corrupt row: span [{start}, {end}) has a boundary inside the expanded "
                    f"token {tokens[idx]!r} at [{s}, {e}) — un-retargetable (raw={raw!r})"
                )
        out["span_starts"] = new_starts
        out["span_ends"] = new_ends
        out["span_tags"] = list(tags)
    return out


def _expand_token(
    tokens: list[str],
    labels: list[str],
    idx: int,
    expansion: str,
) -> tuple[list[str], list[str]]:
    """Replace token at `idx` with a multi-word expansion, updating labels with B-/I- continuation."""
    orig_label = labels[idx]
    expansion_words = expansion.split()

    if len(expansion_words) == 1:
        new_tokens = tokens[:idx] + [expansion_words[0]] + tokens[idx + 1 :]
        new_labels = labels[:]
        return new_tokens, new_labels

    # Multi-word: first word keeps the original label, rest get I- version.
    if orig_label.startswith("B-"):
        tag = orig_label[2:]
        new_labels_for_expansion = [orig_label] + [f"I-{tag}"] * (len(expansion_words) - 1)
    elif orig_label.startswith("I-"):
        new_labels_for_expansion = [orig_label] * len(expansion_words)
    else:
        # O label — all expansion words are O
        new_labels_for_expansion = ["O"] * len(expansion_words)

    new_tokens = tokens[:idx] + expansion_words + tokens[idx + 1 :]
    new_labels = labels[:idx] + new_labels_for_expansion + labels[idx + 1 :]
    return new_tokens, new_labels


def glue_region_postcode(row: dict[str, Any], idx: int) -> dict[str, Any]:
    """Return a copy of ``row`` with the whitespace between token ``idx`` (region) and
    token ``idx + 1`` (postcode) removed from ``raw``. Tokens + labels are untouched —
    the split labels project onto the fused surface via char offsets (see module doc).

    Char-offset spans (#519) shift with the splice: every offset at/after the removed gap moves
    left by the gap width, so the region span still ends at the fused boundary and the postcode
    span starts there. A span STRADDLING the gap would be corrupt input (the gap is inter-token
    whitespace between two differently-labeled tokens) — raises rather than guesses."""
    spans = whitespace_spans(row["raw"], row["tokens"])
    region_end = spans[idx][1]
    postcode_begin = spans[idx + 1][0]
    gap = postcode_begin - region_end
    out = {**row, "raw": row["raw"][:region_end] + row["raw"][postcode_begin:]}
    triple = row_span_triple(row)
    if triple is not None:
        starts, ends, tags = triple
        new_starts: list[int] = []
        new_ends: list[int] = []
        for start, end in zip(starts, ends, strict=True):
            if start < postcode_begin < end:
                raise ValueError(
                    f"corrupt row: span [{start}, {end}) straddles the glue gap "
                    f"[{region_end}, {postcode_begin}) (raw={row['raw']!r})"
                )
            new_starts.append(start - gap if start >= postcode_begin else start)
            new_ends.append(end - gap if end > region_end else end)
        out["span_starts"] = new_starts
        out["span_ends"] = new_ends
        out["span_tags"] = list(tags)
    return out


def lowercase_row(row: dict[str, Any]) -> dict[str, Any] | None:
    """Return a copy of ``row`` with ``raw`` + ``tokens`` lowercased; labels + char-offset spans
    pass through UNCHANGED. Lowercasing is length-preserving char-by-char, so every offset still
    lands on the same (now-lowercased) character — no splice, no re-target, the simplest augmentation.

    Teaches the model that a lowercased query is the same address — the #829 lowercase-sensitivity
    class (fully-lowercase US/NL queries degraded to admin / NULL). Model-first: we teach invariance
    from data rather than bolt on a deterministic case-normalizer (which would discard the case
    signal directionals/proper-nouns carry).

    Returns ``None`` when lowercasing is NOT length-preserving char-by-char (rare Unicode like
    'İ' → 'i̇', 2 chars) — yielding then would desync the spans, so we skip that row instead.
    """
    raw: str = row["raw"]
    if any(len(c.lower()) != 1 for c in raw):
        return None
    return {**row, "raw": raw.lower(), "tokens": [t.lower() for t in row["tokens"]]}


# Separator punctuation the punct-drop augmentation strips: the delimiters that SEPARATE fields but
# carry no component identity (comma between "Portland" and "OR", wrapping quotes). Apostrophes inside a
# name ("Ben & Jerry's") sit INSIDE the entity span and are never touched — the drop is gap-only.
DROP_PUNCT: frozenset[str] = frozenset(",\"'")


def drop_separator_punct(row: dict[str, Any], drop_chars: frozenset[str] = DROP_PUNCT) -> dict[str, Any] | None:
    """Return a copy of ``row`` with SEPARATOR punctuation (gap commas/quotes) removed from ``raw`` —
    the delimiter-free / whitespace-only form (#1101; whitespace-only is 64% of the parity gold).

    GAP-ONLY by construction: a punct char is dropped ONLY when it falls in a gap between entity spans
    (no char-offset span [s, e) covers it), so entity surfaces — including interior apostrophes like
    "Ben & Jerry's" — are never mutated and no span can shrink to empty. Everything stays aligned:

    - ``raw``: the gap punct chars are deleted.
    - char-offset spans (#519): remapped by ``new = old − (dropped chars strictly before old)``. A
      span's start is always a COVERED char (never a drop position), and its exclusive end shifts only
      by the drops before it — so entity boundaries land exactly on the same characters in the new raw.
    - ``tokens`` / ``labels``: each token is rebuilt from its char range minus the drop positions; a
      token that was ONLY separator punct (a standalone ``","``) is dropped along with its label. This
      keeps ``whitespace_spans`` able to relocate every token in the mutated raw (the glue augmentation
      can leave tokens intact because it never alters a token's own characters; punct-drop does).

    Returns ``None`` for a legacy (span-less) row — without spans we can't tell a separator comma from
    one inside an entity, so we skip rather than risk corrupting a label. Also ``None`` when the row has
    no droppable separator punct (nothing to yield)."""
    triple = row_span_triple(row)
    if triple is None:
        return None
    starts, ends, tags = triple
    raw: str = row["raw"]

    covered = [False] * len(raw)
    for s, e in zip(starts, ends, strict=True):
        for p in range(max(0, s), min(len(raw), e)):
            covered[p] = True

    drop_positions = sorted(p for p, c in enumerate(raw) if c in drop_chars and not covered[p])
    if not drop_positions:
        return None
    drop_set = set(drop_positions)

    # old offset -> count of dropped chars strictly before it (for the span remap).
    def shifted(offset: int) -> int:
        # bisect without importing: dropped positions are sorted; count those < offset.
        lo, hi = 0, len(drop_positions)
        while lo < hi:
            mid = (lo + hi) // 2
            if drop_positions[mid] < offset:
                lo = mid + 1
            else:
                hi = mid
        return offset - lo

    new_raw = "".join(c for p, c in enumerate(raw) if p not in drop_set)
    new_starts = [shifted(s) for s in starts]
    new_ends = [shifted(e) for e in ends]

    ws = whitespace_spans(raw, row["tokens"])
    new_tokens: list[str] = []
    new_labels: list[str] = []
    for (ts, te), label in zip(ws, row["labels"], strict=True):
        rebuilt = "".join(raw[j] for j in range(ts, te) if j not in drop_set)
        if rebuilt:
            new_tokens.append(rebuilt)
            new_labels.append(label)

    return {
        **row,
        "raw": new_raw,
        "tokens": new_tokens,
        "labels": new_labels,
        "span_starts": new_starts,
        "span_ends": new_ends,
        "span_tags": list(tags),
    }


def upper_case_row(row: dict[str, Any]) -> dict[str, Any] | None:
    """Return a copy of ``row`` with ``raw`` + ``tokens`` upper-cased; labels + char-offset spans pass
    through UNCHANGED — the exact mirror of :func:`lowercase_row` (#829) for the ALL-CAPS direction.

    Registry corpora (NPPES, Kartverket, state boards) arrive ALL-CAPS; the shipped pipeline handles
    them with a pre-model case-normalize shim (#690). This augmentation is the punct-drop-pattern
    (#1101) retirement path for that shim: teach the case in training so the shim can be deleted.

    Returns ``None`` when upper-casing is NOT length-preserving char-by-char (German eszett 'ß' → "SS")
    — yielding then would desync the spans, so we skip that row instead, mirroring lowercase_row.
    """
    raw: str = row["raw"]
    if any(len(c.upper()) != 1 for c in raw):
        return None
    upper = raw.upper()
    if upper == raw:
        return None
    return {**row, "raw": upper, "tokens": [t.upper() for t in row["tokens"]]}
