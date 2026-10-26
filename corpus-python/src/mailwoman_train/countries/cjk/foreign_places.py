"""Route CJK-script place rows of non-CJK countries into the CJK family's training corpus (#2846).

The wof-admin adapter writes each place's hierarchy in every preferred-name language, so `ニューヨーク州ブルックリン区`
and `뉴욕 주 브루클린` are rows of country US. The CJK family's corpus is built from JP, CN and KR sources only, and the
Latin family is the one that reads country US. Without this builder, a CJK-script hierarchy of a place outside the
CJK countries trains neither the family that serves CJK input nor anything useful in the Latin family, whose
vocabulary spends byte pieces on it.

This builder reads a corpus file, keeps every row of a country outside `CJK_COUNTRIES` whose letters are at least
`MIN_CJK_SHARE` Han, Kana or Hangul, and writes them as a versioned corpus in the CJK schema: `train/` and `val/`
parts, a sealed char vocabulary and a MANIFEST. `overlay.py` takes the result as an extra corpus. A row's split comes
from the split attribute the corpus build wrote. Test rows stay out of training.

Usage::

    uv run python -m mailwoman_train.countries.cjk.foreign_places \\
        --parquet <corpus dir>/wof-admin.parquet --split-attribute <corpus dir>/wof-admin.split.<hash>.json \\
        --out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-cjk-foreign-places-<date>
"""

from __future__ import annotations

import argparse
import json
import unicodedata
from collections import Counter
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq

from ...corpora.builder import CJK_LABEL_SET_NAME, verify_cjk_record, write_corpus_parquet
from ...labels import resolve_label_set
from ...tokenizer.char import build_char_vocab, save_char_vocab
from ...tokenizer.spans import utf16_boundaries

#: Countries whose rows the CJK family already reads from its own sources.
CJK_COUNTRIES: frozenset[str] = frozenset({"JP", "CN", "TW", "HK", "MO", "KR", "KP"})

#: The least share of a row's letters in Han, Kana or Hangul for the row to route to the CJK family.
#:
#: A localized hierarchy is written wholly in its language, so its share is 1.0. A row that keeps a Latin ancestor
#: (`フェアモント, WV`) mixes scripts, and the mixed-script record (2026-10-25) routes those by the script of the address
#: body rather than here.
MIN_CJK_SHARE = 0.9

#: The rows keep the corpus source they came from, so the source register and rights records already cover them.
SOURCE = "wof-admin"
REGISTER = "wof-foreign-cjk"


def cjk_share(text: str) -> float:
    """The share of `text`'s letters that are Han, Kana or Hangul, or 0 for a text with no letter."""
    letters = cjk = 0
    for character in text:
        if not character.isalpha():
            continue
        letters += 1
        name = unicodedata.name(character, "")
        if name.startswith(("CJK UNIFIED", "CJK COMPATIBILITY", "HIRAGANA", "KATAKANA", "HANGUL")):
            cjk += 1
    return cjk / letters if letters else 0.0


def is_foreign_cjk_row(row: dict[str, Any]) -> bool:
    """Whether a row is a CJK-script place row of a country outside `CJK_COUNTRIES`."""
    return row["country"] not in CJK_COUNTRIES and cjk_share(row["raw"]) >= MIN_CJK_SHARE


def held_out_ids(split_attribute: Path) -> dict[str, str]:
    """`source_id` → `val` or `test`, from a split attribute file `corpus split-overlay` wrote."""
    attribute = json.loads(split_attribute.read_text(encoding="utf-8"))
    return {source_id: split for split in ("val", "test") for source_id in attribute[split]}


def foreign_rows(parquet: Path) -> Iterator[dict[str, Any]]:
    columns = ["raw", "tokens", "labels", "span_starts", "span_ends", "span_tags", "country", "source_id"]
    for batch in pq.ParquetFile(parquet).iter_batches(columns=columns, batch_size=65_536):
        for row in batch.to_pylist():
            if is_foreign_cjk_row(row):
                yield row


def to_record(row: dict[str, Any]) -> dict[str, Any]:
    """The CJK-schema record of one corpus row, with its span offsets moved from UTF-16 units to code points."""
    starts = [int(value) for value in row["span_starts"]]
    ends = [int(value) for value in row["span_ends"]]
    boundaries = utf16_boundaries(row["raw"], [*starts, *ends])
    return {
        "raw": row["raw"],
        "tokens": list(row["tokens"]),
        "labels": list(row["labels"]),
        "span_starts": [boundaries[start] for start in starts],
        "span_ends": [boundaries[end] for end in ends],
        "span_tags": list(row["span_tags"]),
        "country": row["country"],
        "source": SOURCE,
        "register": REGISTER,
    }


def build(*, parquet: Path, split_attribute: Path, out_dir: Path, force: bool = False) -> dict[str, Any]:
    """Write the foreign-place CJK corpus and return its build report."""
    if out_dir.exists() and any(out_dir.iterdir()) and not force:
        raise RuntimeError(f"{out_dir} is not empty; pass --force to overwrite")

    tag_set = frozenset(resolve_label_set(CJK_LABEL_SET_NAME).tags)
    held = held_out_ids(split_attribute)
    by_split: dict[str, list[dict[str, Any]]] = {"train": [], "val": []}
    countries: Counter[str] = Counter()
    refused: Counter[str] = Counter()
    test_rows = 0

    for row in foreign_rows(parquet):
        split = held.get(row["source_id"], "train")
        if split == "test":
            test_rows += 1
            continue
        record = to_record(row)
        try:
            verify_cjk_record(record, tag_set)
        except RuntimeError as error:
            refused[str(error).split(":", maxsplit=1)[0]] += 1
            continue
        by_split[split].append(record)
        countries[row["country"]] += 1

    if not by_split["train"]:
        raise RuntimeError(f"{parquet} holds no CJK-script row of a non-CJK country")

    for split, records in by_split.items():
        (out_dir / split).mkdir(parents=True, exist_ok=True)
        if records:
            write_corpus_parquet(records, out_dir / split / f"{SOURCE}-0000.parquet", context="foreign-place CJK build")

    save_char_vocab(
        build_char_vocab((r["raw"] for r in by_split["train"]), min_count=2), out_dir / "char-vocab-foreign.json"
    )

    manifest = {
        "corpus_version": out_dir.name,
        "label_set": CJK_LABEL_SET_NAME,
        "note": f"CJK-script rows of countries outside {sorted(CJK_COUNTRIES)} from {parquet.name}, for the CJK family.",
        "files": [
            {"path": str(out_dir / split / f"{SOURCE}-0000.parquet"), "split": split, "source": SOURCE}
            for split, records in by_split.items()
            if records
        ],
    }
    (out_dir / "MANIFEST.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    report = {
        "parquet": str(parquet),
        "split_attribute": str(split_attribute),
        "rows": {split: len(records) for split, records in by_split.items()},
        "test_rows_left_out": test_rows,
        "refused": dict(refused),
        "countries": dict(countries.most_common()),
    }
    (out_dir / "build-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return report


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", maxsplit=1)[0])
    parser.add_argument("--parquet", required=True, type=Path)
    parser.add_argument("--split-attribute", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    print(
        json.dumps(
            build(parquet=args.parquet, split_attribute=args.split_attribute, out_dir=args.out_dir, force=args.force),
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
