"""Move a row's postcode to the far side of its locality-and-region block (#2750).

A postcode is identified by its form, and a model that has only seen it on its country's native side learns its
slot instead. This augmentation copies a row with the postcode moved across the contiguous block its locality and
region spans form: ``Calle Mayor 12, 28013 Madrid`` becomes ``Calle Mayor 12, Madrid 28013``. The side the postcode
starts on must be the side libaddressinput's ``fmt`` states for the country, read from ``postcode-layouts.json``,
which ``packages/mailwoman/tools/dev-tools/postcode/country-formats.ts`` generates. A row already on the other side
is left alone, so the augmentation never writes a native-order duplicate.

The separator between the block and the postcode belongs to the boundary between the two spans, so it stays between
them: ``Madrid, 28013`` becomes ``28013, Madrid``. A whitespace token that includes the separator (``Madrid,``)
is split at the boundary and keeps only its word, so each token moves with the unit it sits in, and
``whitespace_spans`` confirms every token lands where its offsets say.

A row that cannot be moved without a guess is skipped under a named reason, and the caller counts it.
"""

from __future__ import annotations

import json
import re
from functools import cache
from typing import Any

from ...paths import package_path
from ...tokenizer import whitespace_spans
from .splice import row_span_triple

ADMIN_BLOCK_TAGS: frozenset[str] = frozenset({"locality", "region"})

# The text allowed between the block and the postcode. Anything else is an unlabeled word that would have to move
# with one side or the other, which is a guess.
_SEPARATOR = re.compile(r"[\s,;/.\-–—]+")


class SkipReason:
    """Why a row was not moved. Each value is a counter key."""

    NO_SPANS = "no_spans"
    """The row stores no char-offset span triple."""
    NO_STREET = "no_street"
    """The row has no street span, so it is not an address line with an admin tail."""
    NO_POSTCODE = "no_postcode"
    """The row has no postcode span."""
    NO_LAYOUT = "no_layout"
    """libaddressinput states no layout printing a postcode for the row's country."""
    NO_LOCALITY_FIELD = "no_locality_field"
    """The country's layout prints a postcode and no locality (JP, SG, GI, KY)."""
    LAYOUT_BETWEEN = "layout_between"
    """The country's layout prints the postcode inside the locality-and-region block (IN, NG, PE, PG, PH, VE)."""
    NOT_BLOCK = "not_block"
    """The locality and region spans do not form one block with the postcode beside it, joined by a separator."""
    NON_NATIVE = "non_native"
    """The postcode already sits on the side the country's layout does not use."""
    WORD_ACROSS_BOUNDARY = "word_across_boundary"
    """A token holds text on both sides of a unit boundary, so it cannot move with either side."""
    SPANS_OVERLAP = "spans_overlap"
    """The input's spans overlap or nest, so no split moves one without part of another."""
    SPAN_EDGE_WHITESPACE = "span_edge_whitespace"
    """The moved block or the postcode starts or ends on whitespace (a locality span holding the space after the
    street), so the move would glue the postcode to the word before it (``MAIN ST11550``)."""
    INVALID_OUTPUT = "invalid_output"
    """The moved row's spans are out of bounds, unsorted or overlapping. The move refuses rather than emit a row the
    encoder rejects."""


@cache
def postcode_layouts() -> dict[str, str | None]:
    """Each country's postcode side relative to its locality-and-region block, keyed by ISO 3166-1 alpha-2."""
    document = json.loads(package_path("data", "augment", "postcode-layouts.json").read_text(encoding="utf-8"))
    return dict(document["countries"])


def move_postcode(
    row: dict[str, Any], layouts: dict[str, str | None] | None = None
) -> tuple[dict[str, Any] | None, str | None]:
    """Return ``(moved_row, None)``, or ``(None, reason)`` with a `SkipReason` value when the row is skipped."""
    layouts = postcode_layouts() if layouts is None else layouts
    triple = row_span_triple(row)
    if triple is None:
        return None, SkipReason.NO_SPANS
    starts, ends, tags = triple
    if "street" not in tags:
        return None, SkipReason.NO_STREET
    if "postcode" not in tags:
        return None, SkipReason.NO_POSTCODE

    country = str(row.get("country") or "").upper()
    if country not in layouts:
        return None, SkipReason.NO_LAYOUT
    native = layouts[country]
    if native is None:
        return None, SkipReason.NO_LOCALITY_FIELD
    if native == "between":
        return None, SkipReason.LAYOUT_BETWEEN

    if tags.count("postcode") != 1:
        return None, SkipReason.NOT_BLOCK
    order = sorted(range(len(starts)), key=lambda i: starts[i])
    if not _spans_ordered(len(row["raw"]), [(starts[i], ends[i]) for i in order]):
        return None, SkipReason.SPANS_OVERLAP
    position = order.index(tags.index("postcode"))
    before = _admin_run(order, tags, range(position - 1, -1, -1))
    after = _admin_run(order, tags, range(position + 1, len(order)))
    admin_total = sum(tag in ADMIN_BLOCK_TAGS for tag in tags)
    run = before or after
    if (before and after) or len(run) != admin_total or not any(tags[i] == "locality" for i in run):
        return None, SkipReason.NOT_BLOCK

    # The postcode follows the block when the run sits before it.
    side = "after" if before else "before"
    if side != native:
        return None, SkipReason.NON_NATIVE

    raw: str = row["raw"]
    postcode_index = order[position]
    block = (min(starts[i] for i in run), max(ends[i] for i in run))
    pc = (starts[postcode_index], ends[postcode_index])
    (s1, e1), (s2, e2) = (block, pc) if side == "after" else (pc, block)
    if any(raw[offset].isspace() for offset in (s1, e1 - 1, s2, e2 - 1)):
        return None, SkipReason.SPAN_EDGE_WHITESPACE
    if not _SEPARATOR.fullmatch(raw[e1:s2]):
        return None, SkipReason.NOT_BLOCK
    moved_indices = {*run, postcode_index}
    if any(i not in moved_indices and starts[i] < e2 and ends[i] > s1 for i in range(len(starts))):
        return None, SkipReason.NOT_BLOCK

    def shifted(offset: int, *, end: bool) -> int:
        """Where ``offset`` lands once the units at [s1, e1) and [s2, e2) swap around the separator."""
        # A start is inside a unit on [s, e) and an end on (s, e], so a span ending where a unit starts stays put.
        inside_first = s1 < offset <= e1 if end else s1 <= offset < e1
        inside_second = s2 < offset <= e2 if end else s2 <= offset < e2
        if inside_first:
            return offset + (e2 - e1)
        if inside_second:
            return offset - (s2 - s1)
        if e1 <= offset <= s2:
            return offset + (e2 - s2) - (e1 - s1)
        return offset

    new_raw = raw[:s1] + raw[s2:e2] + raw[e1:s2] + raw[s1:e1] + raw[e2:]

    tokens: list[str] = row["tokens"]
    labels: list[str] = row["labels"]
    placed: list[tuple[int, str, str]] = []
    for (start, end), label in zip(whitespace_spans(raw, tokens), labels, strict=True):
        # A whitespace token such as `Madrid,` includes the boundary separator. Split the token at each unit
        # boundary and drop the pieces that are only separator, so the comma stays at the boundary and the word moves.
        edges = sorted({start, end, *(b for b in (s1, e1, s2, e2) if start < b < end)})
        pieces = [(a, b) for a, b in zip(edges, edges[1:], strict=False) if not _SEPARATOR.fullmatch(raw[a:b])]
        if not pieces and len(edges) == 2:
            # A token of separator alone (the `-` in `São Paulo - SP`) inside one unit moves with that unit.
            pieces = [(start, end)]
        if len(pieces) != 1:
            return None, SkipReason.WORD_ACROSS_BOUNDARY
        piece_start, piece_end = pieces[0]
        placed.append((shifted(piece_start, end=False), raw[piece_start:piece_end], label))
    placed.sort(key=lambda item: item[0])
    new_tokens = [token for _, token, _ in placed]
    if [start for start, _ in whitespace_spans(new_raw, new_tokens)] != [start for start, _, _ in placed]:
        return None, SkipReason.WORD_ACROSS_BOUNDARY

    spans = sorted(
        (shifted(start, end=False), shifted(end, end=True), tag)
        for start, end, tag in zip(starts, ends, tags, strict=True)
    )
    if not _spans_ordered(len(new_raw), [(start, end) for start, end, _ in spans]):
        return None, SkipReason.INVALID_OUTPUT
    return {
        **row,
        "raw": new_raw,
        "tokens": new_tokens,
        "labels": [label for _, _, label in placed],
        "span_starts": [start for start, _, _ in spans],
        "span_ends": [end for _, end, _ in spans],
        "span_tags": [tag for _, _, tag in spans],
    }, None


def _spans_ordered(length: int, spans: list[tuple[int, int]]) -> bool:
    """Whether ``spans``, in order, are non-empty, in bounds, sorted and disjoint, as `char_label_array_from_spans`
    requires."""
    previous_end = 0
    for start, end in spans:
        if not (previous_end <= start < end <= length):
            return False
        previous_end = end
    return True


def _admin_run(order: list[int], tags: list[str], positions: range) -> list[int]:
    """The span indices of consecutive admin-block spans walking ``positions`` from the postcode outward."""
    run: list[int] = []
    for position in positions:
        index = order[position]
        if tags[index] not in ADMIN_BLOCK_TAGS:
            break
        run.append(index)
    return run
