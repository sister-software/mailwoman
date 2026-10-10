"""Address phenomena measured over corpus rows: unary predicates over one row, relational ones over a pair.

The phenomenon ids are ``ConventionClaimID`` values from ``packages/codex/lib/address/convention-claims.ts``.
That module records what a published layout *states* (a convention observation). This module records
what a corpus row *contains* (a corpus observation). The two share ids so a report can place them side
by side. Each is evidence about its own layer only. What a trained model does with either is a decoder
observation. The contrast board measures that.

A row is read as a list of ``(tag, start, end)`` spans over its ``raw`` text. A built corpus row holds
those spans (``span_starts``, ``span_ends``, ``span_tags``). A canonical adapter row holds a component
dict instead, and :func:`spans_from_components` locates each value in ``raw``.

Every unary predicate returns ``None`` when the row does not hold the components the phenomenon is
about, and a short string stating which form the row exercises when it does. The string is the
observation. A caller counting rows counts each form, so a row exercising the opposite order is
counted under its own form.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from typing import Final, NamedTuple

from ..tokenizer.byte_fallback import detect_script

#: The phenomenon ids, mirroring ``ConventionClaimID``. ``test_exposure`` compares this tuple with
#: the TypeScript declaration, so a renamed id fails here rather than drifting.
PHENOMENON_IDS: Final[tuple[str, ...]] = (
    "postcode-precedes-locality",
    "house-number-precedes-street",
    "largest-unit-first",
    "ordering-reverses-with-script",
    "streetless-premise-identity",
    "premise-subdivision-present",
    "fixed-width-numeric-postcode",
    "planning-word-names-locality",
)

UNARY: Final[str] = "unary"
RELATIONAL: Final[str] = "relational"

ARITY: Final[dict[str, str]] = {
    phenomenon: RELATIONAL if phenomenon == "ordering-reverses-with-script" else UNARY for phenomenon in PHENOMENON_IDS
}

#: Premise-subdivision components across every registered label set. JP ``block``/``sub_block``/
#: ``building_number`` are parts of a house number (rule D4) rather than premise subdivisions.
PREMISE_SUBDIVISION_TAGS: Final[frozenset[str]] = frozenset(
    {
        "unit",
        "unit_designator",
        "level_designator",
        "level_id",
        "building_designator",
        "building_id",
        "entrance",
        "staircase",
    }
)

#: Components smaller than a region, for the ``largest-unit-first`` comparison.
SMALLER_THAN_REGION: Final[frozenset[str]] = frozenset(
    {"locality", "dependent_locality", "street", "house_number", "municipality", "district", "locality_unit"}
)

#: The controlled planning vocabulary. These three words are the ones the decoder-exposure handoff
#: (2026-10-03) names. A new term is added here with its source, and the report preserves which term
#: matched so a count can be split by term.
PLANNING_TERMS: Final[tuple[str, ...]] = ("sector", "block", "phase")

_PLANNING = re.compile(r"\b(" + "|".join(PLANNING_TERMS) + r")\b", re.IGNORECASE)


class Span(NamedTuple):
    tag: str
    start: int
    end: int


class Row(NamedTuple):
    """One address row as the phenomenon predicates read it."""

    raw: str
    country: str
    spans: tuple[Span, ...]

    def first(self, tag: str) -> Span | None:
        return next((span for span in self.spans if span.tag == tag), None)

    def has(self, tag: str) -> bool:
        return any(span.tag == tag for span in self.spans)

    def text(self, span: Span) -> str:
        return self.raw[span.start : span.end]


class LocateError(ValueError):
    """A component value that does not occur in the row's raw text."""


def spans_from_components(raw: str, components: Mapping[str, str]) -> tuple[Span, ...]:
    """Locate each component value in ``raw``, case-insensitively, without reusing a located range.

    Raises :class:`LocateError` naming the component when a value does not occur. A row that cannot be
    located is reported by the caller as unreadable rather than measured as carrying fewer components.
    """
    folded = raw.casefold()
    taken: list[tuple[int, int]] = []
    spans: list[Span] = []
    for tag, value in components.items():
        needle = value.casefold()
        if not needle:
            continue
        at = folded.find(needle)
        while at != -1 and any(at < end and at + len(needle) > start for start, end in taken):
            at = folded.find(needle, at + 1)
        if at == -1:
            raise LocateError(f"component {tag}={value!r} does not occur in {raw!r}")
        taken.append((at, at + len(needle)))
        spans.append(Span(tag, at, at + len(needle)))
    return tuple(sorted(spans, key=lambda span: span.start))


def row_from_spans(raw: str, country: str, starts: Sequence[int], ends: Sequence[int], tags: Sequence[str]) -> Row:
    spans = tuple(sorted((Span(t, s, e) for s, e, t in zip(starts, ends, tags, strict=True)), key=lambda x: x.start))
    return Row(raw, country, spans)


def _order(row: Row, earlier: str, later: str) -> str | None:
    a, b = row.first(earlier), row.first(later)
    if a is None or b is None:
        return None
    return "before" if a.start < b.start else "after"


def postcode_precedes_locality(row: Row) -> str | None:
    """``before`` or ``after``: where the first postcode span sits relative to the first locality span."""
    return _order(row, "postcode", "locality")


def house_number_precedes_street(row: Row) -> str | None:
    """``before`` or ``after``: where the first house-number span sits relative to the first street span."""
    return _order(row, "house_number", "street")


def largest_unit_first(row: Row) -> str | None:
    """``region-first`` when the first region span starts before every smaller component, else ``region-later``.

    The comparison is the first ``region`` span's start against the earliest start among the
    components in :data:`SMALLER_THAN_REGION`. A row with no region or no smaller component is silent.
    ``prefecture`` counts as a region-level unit, since SCHEMA.mdx defines it as the JP first-level admin.
    """
    region = row.first("region") or row.first("prefecture")
    smaller = [span.start for span in row.spans if span.tag in SMALLER_THAN_REGION]
    if region is None or not smaller:
        return None
    return "region-first" if region.start < min(smaller) else "region-later"


def streetless_premise_identity(row: Row) -> str | None:
    """``streetless`` when a house number is present, a street absent, and a locality or dependent locality present."""
    if not row.has("house_number") or row.has("street"):
        return None
    if row.has("locality") or row.has("dependent_locality"):
        return "streetless"
    return None


def premise_subdivision_present(row: Row) -> str | None:
    """The sorted, ``+``-joined subdivision tags the row holds, such as ``unit`` or ``entrance+unit``."""
    present = sorted({span.tag for span in row.spans if span.tag in PREMISE_SUBDIVISION_TAGS})
    return "+".join(present) if present else None


def fixed_width_numeric_postcode(row: Row) -> str | None:
    """``<n>-digit`` when the first postcode span is a run of ASCII digits, after removing spaces.

    The width is reported rather than checked against a per-country table, so a report shows which
    widths each jurisdiction's rows exercise. Six-digit exposure in RU, CN and IN is read off this value.
    """
    span = row.first("postcode")
    if span is None:
        return None
    text = row.text(span).replace(" ", "")
    return f"{len(text)}-digit" if text.isascii() and text.isdigit() else None


def planning_word_names_locality(row: Row) -> str | None:
    """The lowercased planning term inside the first locality or dependent-locality span that holds one."""
    for span in row.spans:
        if span.tag in ("locality", "dependent_locality"):
            match = _PLANNING.search(row.text(span))
            if match:
                return match.group(1).lower()
    return None


UNARY_PREDICATES: Final[dict[str, Callable[[Row], str | None]]] = {
    "postcode-precedes-locality": postcode_precedes_locality,
    "house-number-precedes-street": house_number_precedes_street,
    "largest-unit-first": largest_unit_first,
    "streetless-premise-identity": streetless_premise_identity,
    "premise-subdivision-present": premise_subdivision_present,
    "fixed-width-numeric-postcode": fixed_width_numeric_postcode,
    "planning-word-names-locality": planning_word_names_locality,
}


def row_phenomena(row: Row) -> dict[str, str]:
    """Every unary phenomenon the row exercises, with the form it exercises."""
    out: dict[str, str] = {}
    for phenomenon, predicate in UNARY_PREDICATES.items():
        value = predicate(row)
        if value is not None:
            out[phenomenon] = value
    return out


# region Relational phenomena


def reordered_pairs(first: Sequence[str], second: Sequence[str]) -> list[tuple[str, str]]:
    """The component pairs whose relative order differs between two tag sequences.

    The same rule as ``reorderedPairs`` in ``convention-claims.ts``: only tags present in both sequences
    are compared, and a single moved component is an ordering change.
    """
    shared = [tag for i, tag in enumerate(first) if tag in second and first.index(tag) == i]
    return [
        (a, b) for i, a in enumerate(shared) for b in shared[i + 1 :] if list(second).index(a) > list(second).index(b)
    ]


def tag_order(row: Row) -> list[str]:
    seen: list[str] = []
    for span in row.spans:
        if span.tag not in seen:
            seen.append(span.tag)
    return seen


def ordering_reverses_with_script(a: Row, b: Row) -> str | None:
    """For two renderings of one address: ``reordered`` or ``same-order``, or None when the pair does not qualify.

    The pair qualifies when both rows hold the same set of component tags and their raw text is in
    different scripts. The caller pairs renderings of the same address, and this function compares
    their order.
    """
    if {span.tag for span in a.spans} != {span.tag for span in b.spans} or len(a.spans) < 2:
        return None
    if detect_script(a.raw) == detect_script(b.raw):
        return None
    return "reordered" if reordered_pairs(tag_order(a), tag_order(b)) else "same-order"


def numeric_shape_across_contexts(a: Row, b: Row) -> str | None:
    """``<n>-digit:<A>/<B>`` when both rows hold an all-digit postcode of one width from two jurisdictions.

    The phenomenon is the same numeric shape under different surrounding grammar. A pair is material
    for a decoder test. Whether the decoder labels both rows correctly is the test's result.
    """
    width_a, width_b = fixed_width_numeric_postcode(a), fixed_width_numeric_postcode(b)
    if width_a is None or width_a != width_b or a.country == b.country:
        return None
    first, second = sorted((a.country, b.country))
    return f"{width_a}:{first}/{second}"


PAIR_PREDICATES: Final[dict[str, Callable[[Row, Row], str | None]]] = {
    "ordering-reverses-with-script": ordering_reverses_with_script,
    "numeric-shape-across-contexts": numeric_shape_across_contexts,
}


def pair_phenomena(a: Row, b: Row) -> dict[str, str]:
    """Every relational phenomenon the pair exercises, with the form it exercises."""
    out: dict[str, str] = {}
    for phenomenon, predicate in PAIR_PREDICATES.items():
        value = predicate(a, b)
        if value is not None:
            out[phenomenon] = value
    return out


# endregion
