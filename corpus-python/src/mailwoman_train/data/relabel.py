from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .augment import row_span_triple

_STREET_SUFFIX_TAG = "street_suffix"


def _bio_component(label: str) -> str | None:
    if label.startswith(("B-", "I-")):
        return label[2:]
    return None


def _has_adjacent_suffix(labels: list[str], end: int) -> bool:
    after = _bio_component(labels[end]) if end < len(labels) else None
    return after == _STREET_SUFFIX_TAG


def _span_has_adjacent_suffix(tags: list[str], index: int) -> bool:
    after = tags[index + 1] if index + 1 < len(tags) else None
    return after == _STREET_SUFFIX_TAG


@dataclass(frozen=True)
class AffixRelabelLexicon:
    directionals: dict[str, str]
    suffixes: dict[str, str]
    version: str

    name_prone: frozenset[str] = frozenset()

    @classmethod
    def load(cls, path: str | Path) -> AffixRelabelLexicon:
        p = Path(path)
        if not p.is_file():
            raise FileNotFoundError(f"affix relabel lexicon not found: {p}")
        data = json.loads(p.read_text())
        for key in ("directionals", "suffixes", "version"):
            if key not in data:
                raise ValueError(f"affix relabel lexicon missing key {key!r}: {p}")
        if not data["directionals"] or not data["suffixes"]:
            raise ValueError(f"affix relabel lexicon has empty vocab: {p}")
        return cls(
            directionals=data["directionals"],
            suffixes=data["suffixes"],
            version=data["version"],
            name_prone=frozenset(data.get("name_prone", ())),
        )


def _is_affix_shaped(words: list[str], lex: AffixRelabelLexicon) -> bool:
    if not words:
        return True
    return words[-1].lower() in lex.suffixes or words[0].lower() in lex.directionals


def split_street_span(words: list[str], lex: AffixRelabelLexicon) -> tuple[int, int] | None:
    if len(words) < 2:
        return None
    prefix = 0
    rest = words

    if len(words) > 2 and words[0].lower() in lex.directionals:
        prefix = 1
        rest = words[1:]

    if len(rest) < 2 or rest[-1].lower() not in lex.suffixes:
        return None
    name = rest[:-1]
    if _is_affix_shaped(name, lex):
        tail_canonical = lex.suffixes.get(name[-1].lower())
        licensed = len(name) >= 2 and tail_canonical in lex.name_prone and name[0].lower() not in lex.directionals
        if not licensed:
            return None
    return (prefix, 1)


def relabel_row(row: dict[str, Any], lex: AffixRelabelLexicon) -> bool:
    labels = row["labels"]
    tokens = row["tokens"]
    changed = False
    i = 0
    n = len(labels)
    while i < n:
        if labels[i] != "B-street":
            i += 1
            continue
        j = i + 1
        while j < n and labels[j] == "I-street":
            j += 1

        if _has_adjacent_suffix(labels, j):
            i = j
            continue

        span_words = tokens[i:j]
        split = split_street_span(span_words, lex)
        if split is not None:
            prefix_count, suffix_count = split
            if prefix_count:
                labels[i] = "B-street_prefix"
            name_start = i + prefix_count
            labels[name_start] = "B-street"
            for k in range(name_start + 1, j - suffix_count):
                labels[k] = "I-street"
            labels[j - suffix_count] = "B-street_suffix"
            changed = True
        i = j
    if relabel_spans(row, lex):
        changed = True
    return changed


def relabel_spans(row: dict[str, Any], lex: AffixRelabelLexicon) -> bool:
    triple = row_span_triple(row)
    if triple is None:
        return False
    starts, ends, tags = triple
    raw = row["raw"]
    new_starts: list[int] = []
    new_ends: list[int] = []
    new_tags: list[str] = []
    changed = False
    for index, (start, end, tag) in enumerate(zip(starts, ends, tags, strict=True)):
        if tag != "street":
            new_starts.append(start)
            new_ends.append(end)
            new_tags.append(tag)
            continue

        if _span_has_adjacent_suffix(tags, index):
            new_starts.append(start)
            new_ends.append(end)
            new_tags.append(tag)
            continue
        words = [(m.group(0), start + m.start(), start + m.end()) for m in re.finditer(r"\S+", raw[start:end])]
        split = split_street_span([w[0] for w in words], lex)
        if split is None:
            new_starts.append(start)
            new_ends.append(end)
            new_tags.append(tag)
            continue
        prefix_count, suffix_count = split
        changed = True
        if prefix_count:
            new_starts.append(words[0][1])
            new_ends.append(words[0][2])
            new_tags.append("street_prefix")
        name_words = words[prefix_count : len(words) - suffix_count]
        new_starts.append(name_words[0][1])
        new_ends.append(name_words[-1][2])
        new_tags.append("street")
        new_starts.append(words[-1][1])
        new_ends.append(words[-1][2])
        new_tags.append("street_suffix")
    if changed:
        row["span_starts"] = new_starts
        row["span_ends"] = new_ends
        row["span_tags"] = new_tags
    return changed


def _audit(lexicon_path: str, corpus_dir: str, rows: int, sample: int) -> None:
    import random

    import pyarrow.parquet as pq

    lex = AffixRelabelLexicon.load(lexicon_path)
    files = sorted(Path(corpus_dir).glob("*.parquet"))
    if not files:
        raise FileNotFoundError(f"no parquet files under {corpus_dir}")
    rng = random.Random(42)
    table = pq.read_table(rng.choice(files), columns=["raw", "tokens", "labels"]).slice(0, rows)
    total = with_street = split_count = prefix_count = 0
    samples: list[tuple[str, list[str], list[str]]] = []
    for raw, tokens, labels in zip(
        table["raw"].to_pylist(), table["tokens"].to_pylist(), table["labels"].to_pylist(), strict=True
    ):
        total += 1
        if "B-street" not in labels:
            continue
        with_street += 1
        row = {"raw": raw, "tokens": tokens, "labels": list(labels)}
        if relabel_row(row, lex):
            split_count += 1
            if "B-street_prefix" in row["labels"]:
                prefix_count += 1
            if len(samples) < sample:
                samples.append((raw, tokens, row["labels"]))
    print(f"lexicon: {lex.version} ({len(lex.directionals)} directional / {len(lex.suffixes)} suffix variants)")
    print(f"rows: {total:,}  with-street: {with_street:,}")
    print(f"split: {split_count:,} ({100 * split_count / max(with_street, 1):.1f}% of street rows)")
    print(f"  with prefix: {prefix_count:,}")
    print(f"\n== sample of {len(samples)} relabeled rows ==")
    for raw, tokens, labels in samples:
        pairs = " ".join(
            f"{t}/{lab.removeprefix('B-').removeprefix('I-')}"
            for t, lab in zip(tokens, labels, strict=True)
            if "street" in lab
        )
        print(f"  {raw}\n    -> {pairs}")


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Audit the affix-split relabel pass on a corpus sample.")
    ap.add_argument("--lexicon", required=True)
    ap.add_argument("--corpus-dir", required=True, help="directory of parquet files (e.g. .../train)")
    ap.add_argument("--rows", type=int, default=10_000)
    ap.add_argument("--sample", type=int, default=25)
    args = ap.parse_args()
    _audit(args.lexicon, args.corpus_dir, args.rows, args.sample)
