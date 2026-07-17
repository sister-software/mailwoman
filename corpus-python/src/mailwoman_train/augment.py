"""Training-time augmentation: expand abbreviations to teach token equivalence.

Four augmentations, applied independently with configurable probability:

1. **Directional expansion**: "NW" → "Northwest", "SE" → "Southeast", etc.
   Teaches the model that both abbreviated and expanded directionals are the same
   component, without requiring inference-time normalization.

2. **Region-abbreviation expansion**: "NY" → "New York", "CA" → "California", etc.
   Only US state abbreviations for now. Teaches the model that "NY" and "New York"
   are both B-region, improving locality/region disambiguation.

3. **Region+postcode glue** (#513): "NY 14201" → "NY14201" in ``raw`` ONLY — the
   ``tokens`` + ``labels`` lists stay split. ``whitespace_spans`` locates tokens by
   substring search (no whitespace requirement), so the char-offset piece projection
   still lands B-region on the letter pieces and B/I-postcode on the digit pieces of
   the fused surface. Teaches the model to split the fused token at the SP-piece
   level (the v4.3.0 "glue" regression class).

The expansion augmentations SPLICE the expansion into ``raw`` at the token's char
range (located via ``whitespace_spans``, same as the glue) AND update the tokens +
labels lists to match; the expanded form inherits the original token's BIO label
(B- for the first word, I- for continuation words). The glue augmentation mutates
``raw`` alone. No augmentation ever rebuilds ``raw`` from the token list — a
``" ".join(tokens)`` rebuild destroys whatever the tokens don't carry (newlines,
double spaces) and re-quantizes spans to token boundaries (a trailing comma inside
a ``"123,"`` token would get absorbed into the po_box span). v0.5.0 (#519) makes
that punctuation essential, so every augmented copy must keep the source raw's
characters except for the deliberate edit (PR #534 open question 3).

**Char-offset spans** (#519, v0.5.0): rows from a v0.5.0 corpus carry
``span_starts``/``span_ends``/``span_tags`` beside tokens/labels, and every augmented COPY this
module yields must re-target them by the same splice arithmetic — offsets after the edit shift by
the replacement's length delta, a span containing the edit grows/shrinks at its end, and a span
boundary falling strictly INSIDE the edited token is impossible to re-target (the
replaced surface no longer exists) and raises loudly. Yielding a mutated raw with the source
row's spans would corrupt the labels silently — the exact hazard that put the augmentation
re-target in the same change as the loader wiring. Rows without spans (frozen pre-v0.5.0
corpora) pass through the legacy token path unchanged; a PARTIAL triple raises.
"""

from __future__ import annotations

import random
from collections.abc import Iterator

from .tokenizer import whitespace_spans

# US directional abbreviations → expanded forms.
DIRECTIONALS: dict[str, str] = {
    "N": "North",
    "S": "South",
    "E": "East",
    "W": "West",
    "NE": "Northeast",
    "NW": "Northwest",
    "SE": "Southeast",
    "SW": "Southwest",
}

# US state abbreviations → full names. Only unambiguous 2-letter codes.
US_STATES: dict[str, str] = {
    "AL": "Alabama",
    "AK": "Alaska",
    "AZ": "Arizona",
    "AR": "Arkansas",
    "CA": "California",
    "CO": "Colorado",
    "CT": "Connecticut",
    "DE": "Delaware",
    "FL": "Florida",
    "GA": "Georgia",
    "HI": "Hawaii",
    "ID": "Idaho",
    "IL": "Illinois",
    "IN": "Indiana",
    "IA": "Iowa",
    "KS": "Kansas",
    "KY": "Kentucky",
    "LA": "Louisiana",
    "ME": "Maine",
    "MD": "Maryland",
    "MA": "Massachusetts",
    "MI": "Michigan",
    "MN": "Minnesota",
    "MS": "Mississippi",
    "MO": "Missouri",
    "MT": "Montana",
    "NE": "Nebraska",
    "NV": "Nevada",
    "NH": "New Hampshire",
    "NJ": "New Jersey",
    "NM": "New Mexico",
    "NY": "New York",
    "NC": "North Carolina",
    "ND": "North Dakota",
    "OH": "Ohio",
    "OK": "Oklahoma",
    "OR": "Oregon",
    "PA": "Pennsylvania",
    "RI": "Rhode Island",
    "SC": "South Carolina",
    "SD": "South Dakota",
    "TN": "Tennessee",
    "TX": "Texas",
    "UT": "Utah",
    "VT": "Vermont",
    "VA": "Virginia",
    "WA": "Washington",
    "WV": "West Virginia",
    "WI": "Wisconsin",
    "WY": "Wyoming",
    "DC": "District of Columbia",
}


SPAN_KEYS = ("span_starts", "span_ends", "span_tags")


def row_span_triple(row: dict) -> tuple[list[int], list[int], list[str]] | None:
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
    starts, ends, tags = values
    if len(starts) != len(ends) or len(starts) != len(tags):
        raise ValueError(
            f"corrupt row: span triple arrays not parallel — "
            f"starts={len(starts)} ends={len(ends)} tags={len(tags)} (raw={row.get('raw')!r})"
        )
    return starts, ends, tags


def splice_expansion(row: dict, idx: int, expansion: str) -> dict:
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


def glue_region_postcode(row: dict, idx: int) -> dict:
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


def lowercase_row(row: dict) -> dict | None:
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


def drop_separator_punct(row: dict, drop_chars: frozenset[str] = DROP_PUNCT) -> dict | None:
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


def upper_case_row(row: dict) -> dict | None:
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


def augment_row(
    row: dict,
    rng: random.Random,
    directional_prob: float = 0.3,
    region_prob: float = 0.3,
    glue_prob: float = 0.0,
    case_prob: float = 0.0,
    punct_drop_prob: float = 0.0,
    upper_case_prob: float = 0.0,
) -> Iterator[dict]:
    """Yield the original row, then optionally an augmented copy.

    Each augmentation fires independently with its configured probability. When an
    augmentation fires, a COPY of the row is yielded with the expansion applied.
    The original row is always yielded first, unchanged.
    """
    yield row

    tokens: list[str] = row["tokens"]
    labels: list[str] = row["labels"]

    # Directional expansion: find directional tokens and expand one.
    if rng.random() < directional_prob:
        directional_indices = [i for i, t in enumerate(tokens) if t in DIRECTIONALS]
        if directional_indices:
            idx = rng.choice(directional_indices)
            yield splice_expansion(row, idx, DIRECTIONALS[tokens[idx]])

    # Region+postcode glue (#513): fuse the last region token with an immediately-following
    # postcode token in raw. Letter→digit boundary only — that's the boundary SentencePiece
    # is guaranteed to split (the eval's glue class); letter→letter fusions (e.g. GB outcodes)
    # could yield a piece straddling the label boundary, which the char projection cannot
    # represent (first-char label wins). The prob guard keeps the rng stream bit-identical
    # for configs that leave the knob at 0.
    if glue_prob > 0 and rng.random() < glue_prob:
        glue_indices = [
            i
            for i in range(len(tokens) - 1)
            if labels[i] in ("B-region", "I-region")
            and labels[i + 1] == "B-postcode"
            and tokens[i][-1:].isalpha()
            and tokens[i + 1][:1].isdigit()
        ]
        if glue_indices:
            yield glue_region_postcode(row, rng.choice(glue_indices))

    # Region-abbreviation expansion: find region-labeled abbreviations and expand one.
    if rng.random() < region_prob:
        region_indices = [
            i
            for i, (t, lab) in enumerate(zip(tokens, labels, strict=True))
            if t in US_STATES and lab in ("B-region", "I-region")
        ]
        if region_indices:
            idx = rng.choice(region_indices)
            yield splice_expansion(row, idx, US_STATES[tokens[idx]])

    # Case augmentation (#829): a lowercased copy, length-preserving so spans/labels pass through.
    # The prob guard keeps the rng stream bit-identical for configs that leave the knob at 0.
    if case_prob > 0 and rng.random() < case_prob:
        lowered = lowercase_row(row)
        if lowered is not None:
            yield lowered

    # Punct-drop augmentation (#1101): a delimiter-free / whitespace-only copy (separator commas +
    # quotes stripped). The prob guard keeps the rng stream bit-identical for configs at 0.
    if punct_drop_prob > 0 and rng.random() < punct_drop_prob:
        dropped = drop_separator_punct(row)
        if dropped is not None:
            yield dropped

    # All-caps augmentation (#690 retirement path): an upper-cased copy so the model learns registry
    # casing natively. Same prob-guard discipline as punct-drop (rng stream bit-identical at 0).
    if upper_case_prob > 0 and rng.random() < upper_case_prob:
        uppered = upper_case_row(row)
        if uppered is not None:
            yield uppered
