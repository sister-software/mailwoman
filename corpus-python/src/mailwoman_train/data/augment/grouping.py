"""Copy a row with grouping characters added around it or around one of its parts (#2845).

Parentheses, brackets, guillemets and CJK corner brackets reach the tokenizer unchanged, and 810,884 of
703,186,376 rows in the v0.7.10-gb-county train split hold one, almost all inside a name span. A model trained on
that data reads ``"123 Main St, Boston, MA 02111"`` with the house number as a venue, ends the venue of ``Café «Le Dôme»``
at the guillemet, and drops a country written as ``(USA)``. This augmentation writes the copies those inputs need:

- the whole row wrapped in a pair (``[123 Main St, Boston, MA 02111]``);
- the venue or building name wrapped in quotes or brackets (``Café «Le Dôme», 108 Boulevard …``);
- a trailing country set in parentheses (``Boston, MA 02111 (USA)``), or a parenthesized note appended.

A grouping character carries no component. It joins the token beside it, as a separator comma does, and every
char-offset span after it shifts by its length, so each span still covers exactly its component's text.
"""

from __future__ import annotations

import random
import unicodedata
from typing import Any

from ...tokenizer import whitespace_spans
from .splice import row_span_triple

#: Pairs that wrap a whole row or a trailing country in Latin-script text.
LATIN_PAIRS: tuple[tuple[str, str], ...] = (('"', '"'), ("[", "]"), ("(", ")"), ("«", "»"), ("{", "}"))

#: Pairs that wrap a name in Latin-script text.
LATIN_NAME_PAIRS: tuple[tuple[str, str], ...] = (('"', '"'), ("«", "»"), ("“", "”"), ("(", ")"))

#: Pairs used in Han, Kana and Hangul text, where the full-width forms are the ones written.
CJK_PAIRS: tuple[tuple[str, str], ...] = (("「", "」"), ("（", "）"), ("『", "』"), ("【", "】"))

#: Notes appended in parentheses. Each is a remark rather than an address component, so every token is ``O``.
NOTES: tuple[str, ...] = ("rear entrance", "by appointment", "main office", "head office", "temporary address")

#: The component tags a name pair may wrap.
NAME_TAGS: frozenset[str] = frozenset({"venue", "building_name"})


def _is_cjk(text: str) -> bool:
    for character in text:
        name = unicodedata.name(character, "")
        if name.startswith(("CJK UNIFIED", "HIRAGANA", "KATAKANA", "HANGUL")):
            return True
    return False


def _insert(row: dict[str, Any], position: int, text: str) -> dict[str, Any]:
    """Insert ``text`` with no whitespace into ``raw`` at ``position``, attached to the token it touches."""
    raw: str = row["raw"]
    tokens: list[str] = list(row["tokens"])
    spans = whitespace_spans(raw, tokens)

    for index, (start, end) in enumerate(spans):
        if start == position:
            tokens[index] = text + tokens[index]
            break
        if end == position:
            tokens[index] = tokens[index] + text
            break
    else:
        raise ValueError(f"insert position {position} is not a token edge (raw={raw!r})")

    out = {**row, "raw": raw[:position] + text + raw[position:], "tokens": tokens}
    triple = row_span_triple(row)
    if triple is not None:
        starts, ends, tags = triple
        width = len(text)
        out["span_starts"] = [start + width if start >= position else start for start in starts]
        out["span_ends"] = [end + width if end > position else end for end in ends]
        out["span_tags"] = list(tags)
    return out


def _append_words(row: dict[str, Any], text: str) -> dict[str, Any]:
    """Append ``" " + text`` to ``raw`` as new ``O`` tokens."""
    words = text.split()
    return {
        **row,
        "raw": f"{row['raw']} {text}",
        "tokens": [*row["tokens"], *words],
        "labels": [*row["labels"], *["O"] * len(words)],
    }


def wrap_row(row: dict[str, Any], pair: tuple[str, str]) -> dict[str, Any] | None:
    """Return a copy of ``row`` wrapped in ``pair``, or ``None`` when ``raw`` does not begin and end on a token edge.

    A row whose text runs past its last token, such as ``'114, СНТ «Пчёлка»'`` with its closing guillemet outside
    every token, has no token for the closing character to join (#2878).
    """
    edges = {edge for span in whitespace_spans(row["raw"], row["tokens"]) for edge in span}
    if 0 not in edges or len(row["raw"]) not in edges:
        return None
    opened = _insert(row, 0, pair[0])
    return _insert(opened, len(opened["raw"]), pair[1])


def wrap_span(row: dict[str, Any], tags: frozenset[str], pair: tuple[str, str]) -> dict[str, Any] | None:
    """Return a copy with the first span tagged one of ``tags`` wrapped in ``pair``, or ``None`` when there is none.

    The span must begin and end on token edges, so the characters attach to its first and last tokens.
    """
    triple = row_span_triple(row)
    if triple is None:
        return None
    starts, ends, span_tags = triple
    edges = {edge for span in whitespace_spans(row["raw"], row["tokens"]) for edge in span}
    for start, end, tag in zip(starts, ends, span_tags, strict=True):
        if tag in tags and start in edges and end in edges:
            closed = _insert(row, end, pair[1])
            return _insert(closed, start, pair[0])
    return None


def group_row(row: dict[str, Any], rng: random.Random) -> dict[str, Any] | None:
    """Return one grouped copy of ``row``, choosing a variant the row supports, or ``None`` when it supports none."""
    if not row.get("tokens"):
        return None

    cjk = _is_cjk(row["raw"])
    variants: list[str] = ["wrap_row", "note"] if not cjk else ["wrap_row"]
    triple = row_span_triple(row)
    if triple is not None:
        _, ends, tags = triple
        if any(tag in NAME_TAGS for tag in tags):
            variants.append("wrap_name")
        if tags and tags[-1] == "country" and ends[-1] == len(row["raw"].rstrip()):
            variants.append("wrap_country")

    variant = rng.choice(variants)
    if variant == "wrap_row":
        return wrap_row(row, rng.choice(CJK_PAIRS if cjk else LATIN_PAIRS))
    if variant == "wrap_name":
        return wrap_span(row, NAME_TAGS, rng.choice(CJK_PAIRS if cjk else LATIN_NAME_PAIRS))
    if variant == "wrap_country":
        return wrap_span(row, frozenset({"country"}), ("(", ")"))
    return _append_words(row, f"({rng.choice(NOTES)})")
