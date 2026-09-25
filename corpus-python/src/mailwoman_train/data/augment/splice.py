from __future__ import annotations

from typing import Any, cast

from ...tokenizer import whitespace_spans

SPAN_KEYS = ("span_starts", "span_ends", "span_tags")


def row_span_triple(row: dict[str, Any]) -> tuple[list[int], list[int], list[str]] | None:
    values = [row.get(k) for k in SPAN_KEYS]
    present = [v is not None for v in values]
    if not any(present):
        return None
    if not all(present):
        missing = [k for k, p in zip(SPAN_KEYS, present, strict=True) if not p]
        raise ValueError(
            f"corrupt row: partial char-offset span triple (#519) — missing {missing} (raw={row.get('raw')!r})"
        )
    starts, ends, tags = cast(tuple[list[int], list[int], list[str]], values)
    if len(starts) != len(ends) or len(starts) != len(tags):
        raise ValueError(
            f"corrupt row: span triple arrays not parallel — "
            f"starts={len(starts)} ends={len(ends)} tags={len(tags)} (raw={row.get('raw')!r})"
        )
    return starts, ends, tags


def splice_expansion(row: dict[str, Any], idx: int, expansion: str) -> dict[str, Any]:
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
                new_starts.append(start)
                new_ends.append(end)
            elif start >= e:
                new_starts.append(start + delta)
                new_ends.append(end + delta)
            elif start <= s and end >= e:
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
    orig_label = labels[idx]
    expansion_words = expansion.split()

    if len(expansion_words) == 1:
        new_tokens = tokens[:idx] + [expansion_words[0]] + tokens[idx + 1 :]
        new_labels = labels[:]
        return new_tokens, new_labels

    if orig_label.startswith("B-"):
        tag = orig_label[2:]
        new_labels_for_expansion = [orig_label] + [f"I-{tag}"] * (len(expansion_words) - 1)
    elif orig_label.startswith("I-"):
        new_labels_for_expansion = [orig_label] * len(expansion_words)
    else:
        new_labels_for_expansion = ["O"] * len(expansion_words)

    new_tokens = tokens[:idx] + expansion_words + tokens[idx + 1 :]
    new_labels = labels[:idx] + new_labels_for_expansion + labels[idx + 1 :]
    return new_tokens, new_labels


def glue_region_postcode(row: dict[str, Any], idx: int) -> dict[str, Any]:
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
    raw: str = row["raw"]
    if any(len(c.lower()) != 1 for c in raw):
        return None
    return {**row, "raw": raw.lower(), "tokens": [t.lower() for t in row["tokens"]]}


DROP_PUNCT: frozenset[str] = frozenset(",\"'")


def drop_separator_punct(row: dict[str, Any], drop_chars: frozenset[str] = DROP_PUNCT) -> dict[str, Any] | None:
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

    def shifted(offset: int) -> int:

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
    raw: str = row["raw"]
    if any(len(c.upper()) != 1 for c in raw):
        return None
    upper = raw.upper()
    if upper == raw:
        return None
    return {**row, "raw": upper, "tokens": [t.upper() for t in row["tokens"]]}
