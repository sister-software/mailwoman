from __future__ import annotations

import hashlib
import random
from collections import Counter
from collections.abc import Iterable, Iterator
from typing import Any

import pyarrow as pa

from ..text.normalize import normalize_text
from ..tokenizer import char_label_array_from_spans

SCHEMA = pa.schema(
    [
        ("raw", pa.string()),
        ("tokens", pa.list_(pa.string())),
        ("labels", pa.list_(pa.string())),
        ("span_starts", pa.list_(pa.int32())),
        ("span_ends", pa.list_(pa.int32())),
        ("span_tags", pa.list_(pa.string())),
        ("country", pa.string()),
        ("source", pa.string()),
        ("register", pa.string()),
    ]
)


MAX_FIELD_CHARS = 64


MAX_RENDERED_CHARS = 96


class RowRenderer:
    def __init__(self) -> None:
        self.raw = ""
        self.starts: list[int] = []
        self.ends: list[int] = []
        self.tags: list[str] = []

    def put(self, tag: str, text: str) -> None:
        if not text:
            return
        self.starts.append(len(self.raw))
        self.raw += text
        self.ends.append(len(self.raw))
        self.tags.append(tag)

    def glue(self, text: str) -> None:
        self.raw += text


def muni_bucket(municipality: str) -> int:

    return int(hashlib.md5(normalize_text(municipality).encode("utf-8"), usedforsecurity=False).hexdigest(), 16) % 100


def select_exact(count: int, quota: int, rng: random.Random) -> Iterator[bool]:
    remaining_quota = min(quota, count)
    remaining = count
    for _ in range(count):
        take = remaining_quota > 0 and rng.random() < remaining_quota / remaining
        if take:
            remaining_quota -= 1
        remaining -= 1
        yield take


def water_fill(counts: dict[str, int], target: int) -> int:
    if not counts:
        return 0
    low, high = 0, max(counts.values())
    while low < high:
        mid = (low + high + 1) // 2
        if sum(min(mid, n) for n in counts.values()) <= target:
            low = mid
        else:
            high = mid - 1
    return low


def verify_record(
    record: dict[str, Any],
    tag_set: frozenset[str],
    *,
    label_set_name: str,
    max_rendered_chars: int = MAX_RENDERED_CHARS,
    forbid_whitespace: bool = True,
) -> None:
    raw = record["raw"]
    if not record["span_tags"]:
        raise RuntimeError(f"all-O row: {raw!r}")
    if len(raw) > max_rendered_chars:
        raise RuntimeError(f"row of {len(raw)} chars exceeds S={max_rendered_chars} and would truncate: {raw!r}")
    for start, end, tag in zip(record["span_starts"], record["span_ends"], record["span_tags"], strict=True):
        if tag not in tag_set:
            raise RuntimeError(f"tag {tag!r} is outside {label_set_name} — it would collapse to O at load")
        if not raw[start:end]:
            raise RuntimeError(f"empty span {tag}@[{start},{end}) in {raw!r}")
        if forbid_whitespace and any(character.isspace() for character in raw[start:end]):
            raise RuntimeError(f"whitespace inside span {tag}@[{start},{end}): {raw[start:end]!r}")
    char_label_array_from_spans(raw, record["span_starts"], record["span_ends"], record["span_tags"])


CJK_LABEL_SET_NAME = "stage3-cjk"


def verify_cjk_record(record: dict[str, Any], tag_set: frozenset[str]) -> None:
    verify_record(record, tag_set, label_set_name=CJK_LABEL_SET_NAME, forbid_whitespace=False)


def coverage_stats(records: Iterable[dict[str, Any]]) -> dict[str, Any]:
    per_tag_rows: Counter[str] = Counter()
    per_tag_spans: Counter[str] = Counter()
    per_tag_chars: Counter[str] = Counter()
    per_label: Counter[str] = Counter()
    registers: Counter[str] = Counter()
    labeled = total = total_significant = rows = 0
    lengths: list[int] = []
    for record in records:
        rows += 1
        registers[record["register"]] += 1
        raw = record["raw"]
        lengths.append(len(raw))
        array = char_label_array_from_spans(raw, record["span_starts"], record["span_ends"], record["span_tags"])
        for label in array:
            per_label[label] += 1
        total += len(raw)
        total_significant += sum(1 for c in raw if not c.isspace() and c != "〒")
        labeled += sum(1 for label in array if label != "O")
        for tag in set(record["span_tags"]):
            per_tag_rows[tag] += 1
        for start, end, tag in zip(record["span_starts"], record["span_ends"], record["span_tags"], strict=True):
            per_tag_spans[tag] += 1
            per_tag_chars[tag] += end - start
    lengths.sort()
    return {
        "rows": rows,
        "bio_char_coverage_all": round(labeled / total, 6) if total else 0.0,
        "bio_char_coverage_significant": round(labeled / total_significant, 6) if total_significant else 0.0,
        "raw_len_min_median_max": [lengths[0], lengths[len(lengths) // 2], lengths[-1]] if lengths else None,
        "registers": dict(registers.most_common()),
        "per_tag_rows": dict(per_tag_rows.most_common()),
        "per_tag_spans": dict(per_tag_spans.most_common()),
        "per_tag_chars": dict(per_tag_chars.most_common()),
        "per_label_chars": dict(per_label.most_common()),
    }
