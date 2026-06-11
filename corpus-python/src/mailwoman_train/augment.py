"""Training-time augmentation: expand abbreviations to teach token equivalence.

Three augmentations, applied independently with configurable probability:

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

The expansion augmentations replace the token in the raw text AND update the
tokens + labels lists to match; the expanded form inherits the original token's
BIO label (B- for the first word, I- for continuation words). The glue
augmentation mutates ``raw`` alone.

**Char-offset spans** (#519, v0.5.0): rows from a v0.5.0 corpus carry
``span_starts``/``span_ends``/``span_tags`` beside tokens/labels, and every augmented COPY this
module yields must re-target them — the expansion augmentations rebuild ``raw`` (so the spans are
re-derived from the new tokens/labels over the rebuilt surface), and the glue augmentation
splices chars out of ``raw`` (so offsets at/after the splice shift left). Yielding a mutated raw
with the source row's spans would corrupt the labels silently — the exact hazard that put the
augmentation re-target in the same change as the loader wiring. Rows without spans (frozen
pre-v0.5.0 corpora) pass through the legacy token path unchanged; a PARTIAL triple raises.
"""

from __future__ import annotations

import random
from typing import Iterator

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
        missing = [k for k, p in zip(SPAN_KEYS, present) if not p]
        raise ValueError(
            f"corrupt row: partial char-offset span triple (#519) — missing {missing} "
            f"(raw={row.get('raw')!r})"
        )
    starts, ends, tags = values
    if len(starts) != len(ends) or len(starts) != len(tags):
        raise ValueError(
            f"corrupt row: span triple arrays not parallel — "
            f"starts={len(starts)} ends={len(ends)} tags={len(tags)} (raw={row.get('raw')!r})"
        )
    return starts, ends, tags


def spans_from_token_labels(tokens: list[str], labels: list[str]) -> tuple[list[int], list[int], list[str]]:
    """Derive a span triple for a raw REBUILT as ``" ".join(tokens)`` (the expansion augmentations'
    surface): contiguous B-/I- runs become one span each, offsets exact by construction."""
    starts: list[int] = []
    ends: list[int] = []
    tags: list[str] = []
    cursor = 0
    open_tag: str | None = None
    for token, label in zip(tokens, labels):
        begin = cursor
        end = cursor + len(token)
        cursor = end + 1  # single-space join
        if label == "O":
            open_tag = None
            continue
        prefix, tag = label.split("-", 1)
        if prefix == "I" and open_tag == tag:
            ends[-1] = end  # extend the open span across the joining space
        else:
            starts.append(begin)
            ends.append(end)
            tags.append(tag)
        open_tag = tag
    return starts, ends, tags


def _with_rederived_spans(row: dict, augmented: dict) -> dict:
    """Attach a re-derived span triple to an expansion-augmented copy when the source row carries
    spans. The expansions rebuild ``raw`` from the new tokens, so the spans are re-derived from
    the new tokens/labels — the source offsets address a surface that no longer exists."""
    if row_span_triple(row) is None:
        return augmented
    starts, ends, tags = spans_from_token_labels(augmented["tokens"], augmented["labels"])
    return {**augmented, "span_starts": starts, "span_ends": ends, "span_tags": tags}


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
        for start, end in zip(starts, ends):
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


def augment_row(
    row: dict,
    rng: random.Random,
    directional_prob: float = 0.3,
    region_prob: float = 0.3,
    glue_prob: float = 0.0,
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
        directional_indices = [
            i for i, t in enumerate(tokens) if t in DIRECTIONALS
        ]
        if directional_indices:
            idx = rng.choice(directional_indices)
            new_tokens, new_labels = _expand_token(
                tokens, labels, idx, DIRECTIONALS[tokens[idx]]
            )
            new_raw = " ".join(new_tokens)
            yield _with_rederived_spans(
                row,
                {
                    **row,
                    "raw": new_raw,
                    "tokens": new_tokens,
                    "labels": new_labels,
                },
            )

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
            for i, (t, l) in enumerate(zip(tokens, labels))
            if t in US_STATES and l in ("B-region", "I-region")
        ]
        if region_indices:
            idx = rng.choice(region_indices)
            new_tokens, new_labels = _expand_token(
                tokens, labels, idx, US_STATES[tokens[idx]]
            )
            new_raw = " ".join(new_tokens)
            yield _with_rederived_spans(
                row,
                {
                    **row,
                    "raw": new_raw,
                    "tokens": new_tokens,
                    "labels": new_labels,
                },
            )
