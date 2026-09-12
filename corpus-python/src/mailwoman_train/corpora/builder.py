"""The row machinery every corpus builder shares: schema, renderer, sampling, verification, stats.

These names lived in `build_jp_slice.py`, so four sibling builders and a register reader imported a
978-line Japanese builder to get them.
"""

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

# Budget for one row's field values (prefecture + municipality + street + number). The char model
# runs at S=96 units and ``encode_row_units`` truncates past that SILENTLY, so the corpus must not
# contain a row that cannot fit. 64 leaves 32 characters of headroom for everything rendering adds:
# 〒NNN-NNNN + space (10), 日本 (2), three separator spaces, and the designator register's kanji.
# Measured distribution: median rendered row is 18 characters, so this truncates far out in the tail.
MAX_FIELD_CHARS = 64

# The hard invariant the field budget exists to produce. Violation RAISES — reaching it means the
# field budget stopped bounding the rendered length, which is a code defect, not tail data.
MAX_RENDERED_CHARS = 96


class RowRenderer:
    """Concatenate normalized field values large-to-small, recording each span as it lands."""

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
        """Append unlabeled text (the 〒 mark, a separating space) — it stays outside every span."""
        self.raw += text


def muni_bucket(municipality: str) -> int:
    # md5 is a stable bucketing hash here, never a security digest (bandit B324).
    return int(hashlib.md5(normalize_text(municipality).encode("utf-8"), usedforsecurity=False).hexdigest(), 16) % 100


def select_exact(count: int, quota: int, rng: random.Random) -> Iterator[bool]:
    """Stream an exact ``quota``-of-``count`` selection mask (O(1) memory, seeded, no reservoir)."""
    remaining_quota = min(quota, count)
    remaining = count
    for _ in range(count):
        take = remaining_quota > 0 and rng.random() < remaining_quota / remaining
        if take:
            remaining_quota -= 1
        remaining -= 1
        yield take


def water_fill(counts: dict[str, int], target: int) -> int:
    """Largest per-prefecture cap whose total is <= target (so Tokyo cannot drown Tottori)."""
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
    """Re-validate one rendered record through the TRAINING consumer, not through its own author.

    Five independent checks, each of which has a scar behind it: the row fits S=96 so the loader
    never truncates it silently, no span holds whitespace (an interior U+3000 in a source name field
    put one inside a ``district``), every span slices its own text (the secondary-corpus self-check),
    every tag is in the active label set (a tag outside it collapses to ``O`` at load — silent,
    #1349), and the triple survives ``char_label_array_from_spans``, the function the char path
    actually calls.

    `label_set_name` is a parameter because it appears in the message a violation raises. It was a
    module constant read from the defining module, so the TW builder — which imported this from the
    JP one — reported `stage3-jp` for a row it had validated against `stage3-cjk`.

    `forbid_whitespace` is off for the CJK and KR corpora, whose rows carry a labeled space.
    """
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


def coverage_stats(records: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """The BIO coverage the eval protocol asks for — counted on the LABEL ARRAY, not on the JSON.

    ``JSON hides gaps``: a span triple can look complete while the array the model reads is mostly
    ``O``. So this walks ``char_label_array_from_spans`` output, the same array the loader builds.
    """
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
