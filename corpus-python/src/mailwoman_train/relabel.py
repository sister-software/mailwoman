"""Affix-split relabel pass (#511): make the base corpus agree with the affix shard.

The #492 probe ladder found the affix ceiling is contradictory labels: 69.4% of base-corpus
street rows label affix surfaces monolithically (``South County Road 175 West`` = all
``B/I-street``) while the affix shard labels the same surfaces split — at >=1,000:1 effective
gradient mass against the shard. This pass relabels street spans at load time with EXACTLY the
shard builder's split semantics (``scripts/build-street-affix-shard.mjs::parseStreet``), so the
whole mix makes one consistent claim:

- Trailing USPS Pub-28 suffix -> ``B-street_suffix``   (REQUIRED for any split)
- Leading directional        -> ``B-street_prefix``    (only if >2 words, i.e. room for name+suffix)
- The remaining name must be non-empty and not itself affix-shaped (``W Park Ave`` gets NO split
  because "Park" is a suffix variant — the builder rejects it, so we must too; a looser pass here
  would introduce a THIRD labeling and re-create the disease it cures).

Runs AFTER augmentation (see data_loader) so label-inheriting directional expansions
("N"->"North", still street) are caught and split too.

**Char-offset spans** (#519, v0.5.0): rows carrying ``span_starts``/``span_ends``/``span_tags``
get their street SPANS split too — pure char arithmetic on the span's whitespace words (the
builder's exact word-splitting: ``street.trim().split(/\\s+/)``), no token indirection. The token
labels keep their existing relabel for the transition. The two can diverge ONLY on surfaces where
the corpus tokenizer dropped punctuation ("Main St." — tokens see "St" and split; the span path
sees the word "St.", which is not in the lexicon, and conservatively leaves the span whole,
exactly like the builder's parseStreet). The span path is the v0.5.0 source of truth: when a row
has spans, encode_row trains FROM the spans.

Vocab comes from the codex-generated lexicon (scripts/build-affix-relabel-lexicon.mjs ->
data/gazetteer/affix-relabel-lexicon-v1.json) — one source of truth shared with the TS matchers.
Matching is conservative by parity: case-insensitive, NO period stripping ("St." does not match,
same as the builder).

Audit mode (run before any training on a new corpus):
    python -m mailwoman_train.relabel --lexicon <path> --corpus-dir <dir> --rows 10000
prints split rate, per-rule counts, and a sample of relabeled rows for manual inspection.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from .augment import row_span_triple


@dataclass(frozen=True)
class AffixRelabelLexicon:
    directionals: dict[str, str]  # lowercase variant -> canonical abbreviation
    suffixes: dict[str, str]  # lowercase variant -> canonical suffix
    version: str

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
        return cls(directionals=data["directionals"], suffixes=data["suffixes"], version=data["version"])


def _is_affix_shaped(words: list[str], lex: AffixRelabelLexicon) -> bool:
    """Port of the builder's isSuffixOrDirectional: trailing word is a suffix OR leading word is
    a directional. Applied to the candidate NAME to reject splits like 'W Park Ave'."""
    if not words:
        return True
    return words[-1].lower() in lex.suffixes or words[0].lower() in lex.directionals


def split_street_span(words: list[str], lex: AffixRelabelLexicon) -> tuple[int, int] | None:
    """Decide the split for one street span (list of whitespace tokens).

    Returns ``(prefix_count, suffix_count)`` — how many leading tokens become street_prefix
    (0 or 1) and trailing tokens become street_suffix (0 or 1) — or None for no relabel.
    Mirrors build-street-affix-shard.mjs::parseStreet exactly; see module docstring.
    """
    if len(words) < 2:
        return None
    prefix = 0
    rest = words
    # Leading directional — only if it leaves >=2 words behind (room for a name + suffix).
    if len(words) > 2 and words[0].lower() in lex.directionals:
        prefix = 1
        rest = words[1:]
    # Trailing USPS suffix — REQUIRED, and must leave >=1 word for the name.
    if len(rest) < 2 or rest[-1].lower() not in lex.suffixes:
        return None
    name = rest[:-1]
    if _is_affix_shaped(name, lex):
        return None
    return (prefix, 1)


def relabel_row(row: dict, lex: AffixRelabelLexicon) -> bool:
    """Relabel every street span in ``row`` (mutates ``row['labels']`` in place; replaces the
    char-offset span arrays when the row carries them — #519).

    Returns True if any span was split. Rows whose street spans don't meet the builder's
    split contract are left untouched (the shard makes no claim about them either).
    """
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


def relabel_spans(row: dict, lex: AffixRelabelLexicon) -> bool:
    """Split every ``street`` char-offset span in ``row`` with the builder's exact semantics —
    pure char arithmetic (#519).

    The span's raw slice is whitespace-split (the builder's ``street.trim().split(/\\s+/)``,
    punctuation intact — "St." conservatively does not match, same as parseStreet), the split
    decision is the SAME ``split_street_span``, and the street span is replaced in place by up to
    three spans (street_prefix / street / street_suffix) whose offsets are the matched words'
    positions within the original span. Sortedness/non-overlap are preserved by construction —
    every replacement lies inside the original span's range.

    No-op (returns False) on rows without the triple; replaces the three arrays with fresh lists
    when it splits, so callers holding the source row's lists are never mutated through.
    """
    triple = row_span_triple(row)
    if triple is None:
        return False
    starts, ends, tags = triple
    raw = row["raw"]
    new_starts: list[int] = []
    new_ends: list[int] = []
    new_tags: list[str] = []
    changed = False
    for start, end, tag in zip(starts, ends, tags, strict=True):
        if tag != "street":
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
    """Pre-train audit: split rate + per-rule counts + inspection sample. See module docstring."""
    import random

    import pyarrow.parquet as pq

    lex = AffixRelabelLexicon.load(lexicon_path)
    files = sorted(Path(corpus_dir).glob("*.parquet"))
    if not files:
        raise FileNotFoundError(f"no parquet shards under {corpus_dir}")
    rng = random.Random(42)
    table = pq.read_table(rng.choice(files), columns=["raw", "tokens", "labels"]).slice(0, rows)
    total = with_street = split_count = prefix_count = 0
    samples: list[tuple[str, list[str], list[str]]] = []
    for raw, tokens, labels in zip(table["raw"].to_pylist(), table["tokens"].to_pylist(), table["labels"].to_pylist(), strict=True):
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
            f"{t}/{lab.removeprefix('B-').removeprefix('I-')}" for t, lab in zip(tokens, labels, strict=True) if "street" in lab
        )
        print(f"  {raw}\n    -> {pairs}")


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Audit the affix-split relabel pass on a corpus sample.")
    ap.add_argument("--lexicon", required=True)
    ap.add_argument("--corpus-dir", required=True, help="directory of parquet shards (e.g. .../train)")
    ap.add_argument("--rows", type=int, default=10_000)
    ap.add_argument("--sample", type=int, default=25)
    args = ap.parse_args()
    _audit(args.lexicon, args.corpus_dir, args.rows, args.sample)
