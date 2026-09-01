"""Terminal-only carrier audit over the selectable training feed (#1569).

Permanent reconstruction of the 2026-08-09 250k feed audit (the original tool was ad-hoc and
never committed). It streams the exact selectable feed — source multinomial + country/coarse
filtering, no augmentation — classifies every street-family group, applies the load-time
relabel pass under a chosen lexicon, and reports carrier correctness per class and source.

Definitions mirror ``classifySuffixBoundaryStreet`` (corpus/src/recipes/street-affix.ts),
evaluated with the CLASSIFY lexicon's vocabulary (use the v2 artifact — it carries
``name_prone``):

- **terminal-only** — the group's trailing word is a true (non-name-prone) suffix and the word
  before it is name-prone ('Blue Hill Rd'; 'Menlo Park' + 'Road').
- **terminal-contrast** — the trailing word itself is name-prone ('Sutton Hollow').

Correct = after the relabel pass, the group's last word carries ``street_suffix`` and the word
before it carries ``street``. The RELABEL lexicon is the experiment variable: v1 (no
``name_prone``) reproduces the 2026-08-09 baseline — ordinary-source monolithic carriers stay
wrong (695/3,151 = 22.1% in that audit) — and v2 licenses the positional split.

Volume-side run (see ``train_remote.py::audit_suffix_feed``)::

    python -m mailwoman_train.audit_suffix_feed \
      --config src/mailwoman_train/configs/v4.3.3-suffix-boundary-base-60k.yaml \
      --classify-lexicon /data/gazetteer/affix-relabel-lexicon-v2.json \
      --relabel-lexicon /data/gazetteer/affix-relabel-lexicon-v2.json \
      --rows 250000 --seed 1569 --json suffix-feed-audit.json
"""

from __future__ import annotations

import argparse
import json
import random
from collections import Counter
from itertools import islice
from pathlib import Path

from .data_loader import _raw_row_stream
from .relabel import AffixRelabelLexicon, relabel_row

TARGET_SOURCE = "synth-suffix-boundary"


def _component(label: str) -> str | None:
    if label.startswith(("B-", "I-")):
        return label[2:]
    return None


def street_family_groups(labels: list[str]) -> list[list[int]]:
    """Token indices of each street span plus its immediately-following authored suffix span."""
    groups: list[list[int]] = []
    i = 0
    n = len(labels)
    while i < n:
        if labels[i] == "B-street":
            idx = [i]
            i += 1
            while i < n and labels[i] == "I-street":
                idx.append(i)
                i += 1
            if i < n and labels[i] == "B-street_suffix":
                idx.append(i)
                i += 1
                while i < n and labels[i] == "I-street_suffix":
                    idx.append(i)
                    i += 1
            groups.append(idx)
        else:
            i += 1
    return groups


def classify_street_group(words: list[str], classify_lex: AffixRelabelLexicon) -> str | None:
    """Port of ``classifySuffixBoundaryStreet`` over the lexicon vocabulary."""
    if len(words) < 2:
        return None
    terminal = classify_lex.suffixes.get(words[-1].lower())
    if terminal is None:
        return None
    if terminal in classify_lex.name_prone:
        return "terminal-contrast"
    if len(words) < 3:
        return None
    penultimate = classify_lex.suffixes.get(words[-2].lower())
    if penultimate is not None and penultimate in classify_lex.name_prone:
        return "terminal-only"
    return None


def evaluate_row(
    row: dict,
    *,
    classify_lex: AffixRelabelLexicon,
    relabel_lex: AffixRelabelLexicon,
) -> list[tuple[str, bool]]:
    """Classify each street-family group and score the effective (post-relabel) labels.

    Returns ``[(class, correct), ...]`` for the carrier groups; non-carrier groups yield
    nothing. The caller's row is never mutated (the relabel runs on a shallow copy with a
    copied label list — the same discipline the loader uses).
    """
    tokens: list[str] = row["tokens"]
    labels: list[str] = row["labels"]
    groups = street_family_groups(labels)
    if not groups:
        return []

    classified: list[tuple[list[int], str]] = []
    for idx in groups:
        cls = classify_street_group([tokens[j] for j in idx], classify_lex)
        if cls is not None:
            classified.append((idx, cls))
    if not classified:
        return []

    effective = {**row, "labels": list(labels)}
    relabel_row(effective, relabel_lex)
    out: list[tuple[str, bool]] = []
    for idx, cls in classified:
        post = effective["labels"]
        correct = (
            len(idx) >= 2 and _component(post[idx[-1]]) == "street_suffix" and _component(post[idx[-2]]) == "street"
        )
        out.append((cls, correct))
    return out


def audit_feed(
    corpus_dir: Path,
    *,
    seed: int,
    rows: int,
    country_weights: dict[str, float],
    source_weights: dict[str, float] | None,
    coarse_filter: bool,
    classify_lex: AffixRelabelLexicon,
    relabel_lex: AffixRelabelLexicon,
) -> dict:
    stream = _raw_row_stream(
        Path(corpus_dir),
        "train",
        rng=random.Random(seed),
        country_weights=country_weights,
        source_weights=source_weights,
        coarse_filter=coarse_filter,
    )
    carriers: Counter = Counter()
    correct: Counter = Counter()
    per_source_carriers: Counter = Counter()
    per_source_correct: Counter = Counter()
    sampled = 0
    for row in islice(stream, rows):
        sampled += 1
        for cls, ok in evaluate_row(row, classify_lex=classify_lex, relabel_lex=relabel_lex):
            bucket = "target" if row["source"] == TARGET_SOURCE else "ordinary"
            carriers[(cls, bucket)] += 1
            correct[(cls, bucket)] += int(ok)
            per_source_carriers[(cls, row["source"])] += 1
            per_source_correct[(cls, row["source"])] += int(ok)

    def _cell(cls: str, bucket: str) -> dict:
        n = carriers[(cls, bucket)]
        k = correct[(cls, bucket)]
        return {"carriers": n, "correct": k, "rate": (k / n) if n else None}

    report = {
        "meta": {
            "rows_sampled": sampled,
            "seed": seed,
            "corpus_dir": str(corpus_dir),
            "classify_lexicon": classify_lex.version,
            "relabel_lexicon": relabel_lex.version,
        },
        "terminal_only": {
            "total": _cell("terminal-only", "target")["carriers"] + _cell("terminal-only", "ordinary")["carriers"],
            "target": _cell("terminal-only", "target"),
            "ordinary": _cell("terminal-only", "ordinary"),
        },
        "terminal_contrast": {
            "target": _cell("terminal-contrast", "target"),
            "ordinary": _cell("terminal-contrast", "ordinary"),
        },
        "per_source": {
            f"{cls}/{src}": {
                "carriers": per_source_carriers[(cls, src)],
                "correct": per_source_correct[(cls, src)],
            }
            for (cls, src) in sorted(per_source_carriers)
        },
    }
    return report


def run(
    config_path: Path,
    *,
    classify_lexicon: Path,
    relabel_lexicon: Path,
    rows: int = 250_000,
    seed: int = 1569,
    corpus_dir: Path | None = None,
    json_path: Path | None = None,
) -> dict:
    from .config import load_config

    cfg = load_config(config_path)
    d = cfg.data
    classify_lex = AffixRelabelLexicon.load(classify_lexicon)
    if not classify_lex.name_prone:
        raise ValueError(
            f"classify lexicon {classify_lexicon} has no name_prone vocabulary — classification "
            "needs the v2 artifact (the class definitions live in its name-prone set)"
        )
    relabel_lex = AffixRelabelLexicon.load(relabel_lexicon)
    report = audit_feed(
        corpus_dir or Path(d.corpus_dir),
        seed=seed,
        rows=rows,
        country_weights=d.country_weights,
        source_weights=d.source_weights,
        coarse_filter=d.coarse_filter,
        classify_lex=classify_lex,
        relabel_lex=relabel_lex,
    )
    report["meta"]["config"] = str(config_path)
    if json_path is not None:
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"wrote {json_path}")
    t = report["terminal_only"]
    c = report["terminal_contrast"]
    print(
        f"\n=== terminal-only feed audit ({report['meta']['rows_sampled']:,} rows, "
        f"relabel={report['meta']['relabel_lexicon']}) ===\n"
        f"terminal-only  target:   {t['target']['correct']:,}/{t['target']['carriers']:,}\n"
        f"terminal-only  ordinary: {t['ordinary']['correct']:,}/{t['ordinary']['carriers']:,}\n"
        f"contrast       target:   {c['target']['correct']:,}/{c['target']['carriers']:,}\n"
        f"contrast       ordinary: {c['ordinary']['correct']:,}/{c['ordinary']['carriers']:,}"
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--classify-lexicon", required=True, type=Path)
    parser.add_argument("--relabel-lexicon", required=True, type=Path)
    parser.add_argument("--rows", type=int, default=250_000)
    parser.add_argument("--seed", type=int, default=1569)
    parser.add_argument("--corpus-dir", type=Path)
    parser.add_argument("--json", type=Path)
    args = parser.parse_args()
    run(
        args.config,
        classify_lexicon=args.classify_lexicon,
        relabel_lexicon=args.relabel_lexicon,
        rows=args.rows,
        seed=args.seed,
        corpus_dir=args.corpus_dir,
        json_path=args.json,
    )


if __name__ == "__main__":
    main()
