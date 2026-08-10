"""Audit script transitions inside gold address components.

Row-level script diversity is not the same capability as a bilingual or mixed-script
component. ``Rinrin, 高山市`` contains multiple scripts across components; a venue such as
``Four Seasons Inn四季酒家`` changes script inside one semantic span. This audit keeps those
populations separate and reports the latter by component tag, country, and source.

Typical selectable-feed audit::

    python -m mailwoman_train.audit_mixed_script \
      --config src/mailwoman_train/configs/v4.3.1-suffix-boundary-target-dose-8k.yaml \
      --corpus-dir /data/corpus/versioned/v0.18.1-suffix-boundary/corpus-v0.18.1-suffix-boundary \
      --rows 250000 --seed 1569 --json mixed-script-feed.json

The audit consumes the same source/country multinomial as training and optionally applies
the configured affix relabel pass. Enabled augmentations do not create new writing systems,
so they are deliberately excluded from this coverage measurement.
"""

from __future__ import annotations

import argparse
import json
import random
import tempfile
import unicodedata
from collections import Counter, defaultdict
from collections.abc import Iterable, Iterator
from itertools import islice
from pathlib import Path
from typing import Any

import yaml

from .data_loader import _raw_row_stream
from .relabel import AffixRelabelLexicon, relabel_row

_SCRIPT_MARKERS = (
    ("LATIN", "Latin"),
    ("CJK UNIFIED IDEOGRAPH", "Han"),
    ("CJK COMPATIBILITY IDEOGRAPH", "Han"),
    ("HIRAGANA", "Hiragana"),
    ("KATAKANA", "Katakana"),
    ("HANGUL", "Hangul"),
    ("CYRILLIC", "Cyrillic"),
    ("ARABIC", "Arabic"),
    ("HEBREW", "Hebrew"),
    ("GREEK", "Greek"),
    ("DEVANAGARI", "Devanagari"),
    ("THAI", "Thai"),
    ("ARMENIAN", "Armenian"),
    ("GEORGIAN", "Georgian"),
    ("ETHIOPIC", "Ethiopic"),
    ("BENGALI", "Bengali"),
    ("GURMUKHI", "Gurmukhi"),
    ("GUJARATI", "Gujarati"),
    ("TAMIL", "Tamil"),
    ("TELUGU", "Telugu"),
    ("KANNADA", "Kannada"),
    ("MALAYALAM", "Malayalam"),
    ("SINHALA", "Sinhala"),
    ("KHMER", "Khmer"),
    ("LAO", "Lao"),
    ("MYANMAR", "Myanmar"),
)


def character_script(char: str) -> str | None:
    """Return a strong writing-system label; ignore digits, punctuation, marks, and symbols."""
    if not unicodedata.category(char).startswith("L"):
        return None
    name = unicodedata.name(char, "")
    for marker, script in _SCRIPT_MARKERS:
        if marker in name:
            return script
    # Compatibility letters such as Spanish º/ª decompose to ordinary Latin letters. Treating
    # their Unicode category (Lo) as a separate script manufactures Latin→Other transitions.
    compatibility = unicodedata.normalize("NFKD", char)
    if compatibility != char:
        scripts = {script for item in compatibility if (script := character_script(item)) is not None}
        if len(scripts) == 1:
            return scripts.pop()
    return "Other"


def script_runs(text: str) -> list[str]:
    """Return consecutive strong-script runs, with Common/Inherited characters ignored."""
    runs: list[str] = []
    for char in text:
        script = character_script(char)
        if script is not None and (not runs or runs[-1] != script):
            runs.append(script)
    return runs


def _utf16_boundaries(text: str, offsets: Iterable[int]) -> dict[int, int]:
    """Map requested UTF-16 offsets to Python code-point indices, failing on split surrogates."""
    wanted = set(offsets)
    result: dict[int, int] = {}
    units = 0
    if 0 in wanted:
        result[0] = 0
    for index, char in enumerate(text, start=1):
        units += 2 if ord(char) > 0xFFFF else 1
        if units in wanted:
            result[units] = index
    missing = sorted(wanted - result.keys())
    if missing:
        raise ValueError(f"span offsets are not UTF-16 boundaries for {text!r}: {missing}")
    return result


def gold_components(row: dict[str, Any]) -> Iterator[tuple[str, str]]:
    """Yield ``(tag, surface)`` from char spans, falling back to legacy BIO token runs."""
    span_keys = ("span_starts", "span_ends", "span_tags")
    if all(key in row for key in span_keys):
        starts, ends, tags = (row[key] for key in span_keys)
        boundaries = _utf16_boundaries(row["raw"], [*starts, *ends])
        for start, end, tag in zip(starts, ends, tags, strict=True):
            yield tag, row["raw"][boundaries[start] : boundaries[end]]
        return

    tokens = row["tokens"]
    labels = row["labels"]
    index = 0
    while index < len(labels):
        label = labels[index]
        if not label.startswith("B-"):
            index += 1
            continue
        tag = label[2:]
        end = index + 1
        while end < len(labels) and labels[end] == f"I-{tag}":
            end += 1
        yield tag, " ".join(tokens[index:end])
        index = end


def _finalize_counts(counts: Counter[str]) -> dict[str, int | float]:
    result: dict[str, int | float] = dict(sorted(counts.items()))
    scripted = counts["scripted_components"]
    result["mixed_rate"] = counts["mixed_components"] / scripted if scripted else 0.0
    return result


def audit_rows(rows: Iterable[dict[str, Any]], *, examples_per_tag: int = 10) -> dict[str, Any]:
    """Summarize mixed-script gold components from an arbitrary row iterable."""
    totals: Counter[str] = Counter()
    by_tag: defaultdict[str, Counter[str]] = defaultdict(Counter)
    by_country: defaultdict[str, Counter[str]] = defaultdict(Counter)
    by_source: defaultdict[str, Counter[str]] = defaultdict(Counter)
    examples: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)

    for row in rows:
        totals["rows"] += 1
        has_spans = all(key in row for key in ("span_starts", "span_ends", "span_tags"))
        totals["span_truth_rows" if has_spans else "legacy_bio_rows"] += 1
        row_scripts = set(script_runs(row["raw"]))
        if len(row_scripts) > 1:
            totals["rows_with_multiple_scripts"] += 1

        row_has_mixed_component = False
        for tag, surface in gold_components(row):
            totals["components"] += 1
            by_tag[tag]["components"] += 1
            runs = script_runs(surface)
            if not runs:
                continue
            totals["scripted_components"] += 1
            by_tag[tag]["scripted_components"] += 1
            by_country[row["country"]]["scripted_components"] += 1
            by_source[row["source"]]["scripted_components"] += 1
            for script in set(runs):
                by_tag[tag][f"script:{script}"] += 1

            if len(set(runs)) <= 1:
                continue
            row_has_mixed_component = True
            transitions = len(runs) - 1
            totals["mixed_components"] += 1
            totals["script_transitions"] += transitions
            by_tag[tag]["mixed_components"] += 1
            by_tag[tag]["script_transitions"] += transitions
            by_country[row["country"]]["mixed_components"] += 1
            by_source[row["source"]]["mixed_components"] += 1
            for left, right in zip(runs, runs[1:], strict=False):
                by_tag[tag][f"transition:{left}->{right}"] += 1
            if len(examples[tag]) < examples_per_tag:
                examples[tag].append(
                    {
                        "raw": row["raw"],
                        "surface": surface,
                        "scripts": runs,
                        "country": row["country"],
                        "source": row["source"],
                    }
                )

        if row_has_mixed_component:
            totals["rows_with_mixed_component"] += 1

    totals["rows_cross_component_only"] = totals["rows_with_multiple_scripts"] - totals["rows_with_mixed_component"]
    return {
        "totals": _finalize_counts(totals),
        "by_tag": {key: _finalize_counts(value) for key, value in sorted(by_tag.items())},
        "by_country": {key: _finalize_counts(value) for key, value in sorted(by_country.items())},
        "by_source": {key: _finalize_counts(value) for key, value in sorted(by_source.items())},
        "examples": dict(sorted(examples.items())),
    }


def _remap(value: str, mappings: list[tuple[str, str]]) -> str:
    for old, new in mappings:
        if value.startswith(old):
            return new + value[len(old) :]
    return value


def _parse_mappings(values: list[str]) -> list[tuple[str, str]]:
    mappings: list[tuple[str, str]] = []
    for value in values:
        if "=" not in value:
            raise ValueError(f"--path-prefix must be OLD=NEW, got {value!r}")
        mappings.append(tuple(value.split("=", 1)))
    return mappings


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--corpus-dir", type=Path, help="Override data.corpus_dir from the config")
    parser.add_argument("--rows", type=int, default=250_000)
    parser.add_argument("--seed", type=int, default=1569)
    parser.add_argument("--examples-per-tag", type=int, default=10)
    parser.add_argument("--path-prefix", action="append", default=[], metavar="OLD=NEW")
    parser.add_argument("--affix-relabel-lexicon", type=Path, help="Override the configured relabel lexicon path")
    parser.add_argument("--json", type=Path)
    args = parser.parse_args()

    config = yaml.safe_load(args.config.read_text())["data"]
    mappings = _parse_mappings(args.path_prefix)
    corpus_dir = args.corpus_dir or Path(_remap(config["corpus_dir"], mappings))

    with tempfile.TemporaryDirectory(prefix="mw-mixed-script-audit-") as temp:
        stream_dir = corpus_dir
        manifest_path = corpus_dir / "MANIFEST.json"
        if mappings and manifest_path.exists():
            manifest = json.loads(manifest_path.read_text())
            for shard in manifest.get("shards", []):
                shard["path"] = _remap(shard["path"], mappings)
            stream_dir = Path(temp)
            (stream_dir / "MANIFEST.json").write_text(json.dumps(manifest))

        lexicon = None
        lexicon_path = args.affix_relabel_lexicon
        if lexicon_path is None and config.get("affix_relabel_lexicon_path"):
            lexicon_path = Path(_remap(config["affix_relabel_lexicon_path"], mappings))
        if lexicon_path is not None:
            lexicon = AffixRelabelLexicon.load(lexicon_path)

        stream = _raw_row_stream(
            stream_dir,
            "train",
            rng=random.Random(args.seed),
            country_weights=config["country_weights"],
            source_weights=config.get("source_weights"),
            coarse_filter=config["coarse_filter"],
        )

        def effective_rows() -> Iterator[dict[str, Any]]:
            for row in islice(stream, args.rows):
                if lexicon is not None:
                    relabel_row(row, lexicon)
                yield row

        report = audit_rows(effective_rows(), examples_per_tag=args.examples_per_tag)

    report["sample"] = {"rows": args.rows, "seed": args.seed, "config": str(args.config)}
    rendered = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.json:
        args.json.write_text(rendered)
        print(f"wrote {args.json}")
    totals = report["totals"]
    print(
        f"rows={totals['rows']:,} multiple-script={totals['rows_with_multiple_scripts']:,} "
        f"mixed-component={totals['rows_with_mixed_component']:,} "
        f"mixed-components={totals['mixed_components']:,}/{totals['scripted_components']:,} "
        f"({100 * totals['mixed_rate']:.3f}%)"
    )


if __name__ == "__main__":
    main()
