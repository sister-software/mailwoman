"""Build the v8 CJK overlay corpus: the JP full slice plus the CN organizational-unit slice, under one head (#2034).

The JP model (``v8-jp-full``, 24k steps, coordinate-acceptability 0.9928) trained on the 2M-row JP slice with the
47-label ``stage3-jp`` head. The CN rows the `cn-organizational-units` recipe labels (151 over the three coarse-placer
splits) carry one tag that head does not have, ``locality_unit``, so they cannot ride a JP-only run. This builder lays
out the corpus a from-scratch CJK run reads instead:

- **A MANIFEST that references the JP parts where they already are.** The loader's ``_slice_paths`` takes a manifest
  path AS-IS when it exists (the overlay rule from v0.4.0 → v0.3.0), so the eight JP train parts and the JP val part are
  listed by their path under the volume root and never copied. Only the CN parts live in this directory.
- **The CN rows as parquet parts in the JP schema.** The TypeScript recipe emits aligned JSONL (``span_starts`` /
  ``span_ends`` / ``span_tags`` over a per-character tokenization); this builder re-validates every row through the
  training consumer (``char_label_array_from_spans``) against the ``stage3-cjk`` label set and writes ``train/`` and
  ``val/`` parts with ``register = "cn-units"``. The CN test rows become ``cn-board.jsonl`` beside ``jp-board.jsonl``'s
  role: a held-out set for the CN per-tag read, not a coordinate board — no gazetteer carries these units.
- **A re-sealed char vocabulary.** The JP vocabulary was sealed from the JP train split at ``min_count=2``. A CN
  character that appears once in 126 rows would be ``<unk>`` under that rule, so the CN train characters join at
  ``min_count=1`` and the union is re-sorted by code point — the same deterministic ordering ``build_char_vocab`` uses.

WHITESPACE INSIDE A SPAN IS ALLOWED HERE, deliberately. The JP builder refuses it because the one case it met was a
source defect (an interior U+3000 inside a district name). A CN row's Latin admin tail carries a real inner space —
``Inner Mongolia``, ``Xinjiang Uyghur`` — and in ``char_mode: char`` every character is its own unit, the space
included, so the label array is well-formed. The other JP checks (fits S, every span slices its own text, every tag in
the active set, the array builds) are kept.

Usage (local artifact; the manifest paths are written for the volume):

    uv run python -m mailwoman_train.build_cjk_overlay \\
        --jp-corpus $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-jp-full-2026-08-04 \\
        --cn-train <cn-units-train.jsonl> --cn-val <cn-units-val.jsonl> --cn-test <cn-units-test.jsonl> \\
        --out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-cjk-2026-09-05
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from collections.abc import Iterable, Iterator, Sequence
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from .build_jp_slice import MAX_RENDERED_CHARS, SCHEMA
from .char_tokenizer import PAD_CHAR_ID, UNK_CHAR_ID, build_char_vocab, load_char_vocab, save_char_vocab
from .labels import resolve_label_set
from .tokenizer import char_label_array_from_spans

LABEL_SET_NAME = "stage3-cjk"
CN_SOURCE = "coarse-placer-cn-units"
CN_REGISTER = "cn-units"
JP_VERSION = "v8-jp-full-2026-08-04"
DEFAULT_VOLUME_ROOT = "/data/corpus/versioned"


def read_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)


def verify_cn_record(record: dict[str, Any], tag_set: frozenset[str]) -> None:
    """The JP verifier's checks minus the whitespace rule (see the module docstring for why)."""
    raw = record["raw"]
    if not record["span_tags"]:
        raise RuntimeError(f"all-O row: {raw!r}")
    if len(raw) > MAX_RENDERED_CHARS:
        raise RuntimeError(f"row of {len(raw)} chars exceeds S={MAX_RENDERED_CHARS} and would truncate: {raw!r}")
    for start, end, tag in zip(record["span_starts"], record["span_ends"], record["span_tags"], strict=True):
        if tag not in tag_set:
            raise RuntimeError(f"tag {tag!r} is outside {LABEL_SET_NAME} — it would collapse to O at load")
        if not raw[start:end]:
            raise RuntimeError(f"empty span {tag}@[{start},{end}) in {raw!r}")
    char_label_array_from_spans(raw, record["span_starts"], record["span_ends"], record["span_tags"])


def to_cn_record(row: dict[str, Any]) -> dict[str, Any]:
    """One recipe row → one row in the JP parquet schema."""
    return {
        "raw": row["raw"],
        "tokens": list(row["tokens"]),
        "labels": list(row["labels"]),
        "span_starts": [int(value) for value in row["span_starts"]],
        "span_ends": [int(value) for value in row["span_ends"]],
        "span_tags": list(row["span_tags"]),
        "country": "CN",
        "source": row.get("source") or CN_SOURCE,
        "register": CN_REGISTER,
    }


def merge_char_vocab(jp_vocab: dict[str, int], cn_texts: Iterable[str]) -> dict[str, int]:
    """The JP vocabulary plus every CN train character, re-sorted by code point with PAD and UNK fixed."""
    characters = {character for character in jp_vocab if character not in ("<pad>", "<unk>")}
    characters.update(build_char_vocab(cn_texts, min_count=1).keys() - {"<pad>", "<unk>"})
    vocab: dict[str, int] = {"<pad>": PAD_CHAR_ID, "<unk>": UNK_CHAR_ID}
    for index, character in enumerate(sorted(characters), start=2):
        vocab[character] = index
    return vocab


def build(
    *,
    jp_corpus: Path,
    cn_train: Path,
    cn_val: Path,
    cn_test: Path,
    out_dir: Path,
    volume_root: str,
    jp_version: str = JP_VERSION,
    force: bool = False,
) -> dict[str, Any]:
    if out_dir.exists() and any(out_dir.iterdir()) and not force:
        raise RuntimeError(f"{out_dir} is not empty; pass --force to overwrite")
    for split in ("train", "val"):
        (out_dir / split).mkdir(parents=True, exist_ok=True)

    tag_set = frozenset(resolve_label_set(LABEL_SET_NAME).tags)
    jp_parts = {
        split: sorted(path.name for path in (jp_corpus / split).glob("*.parquet")) for split in ("train", "val")
    }
    if not jp_parts["train"] or not jp_parts["val"]:
        raise RuntimeError(f"{jp_corpus} holds no train/val parquet parts")

    counts: dict[str, int] = {}
    tag_counts: Counter[str] = Counter()
    for split, source in (("train", cn_train), ("val", cn_val)):
        records = [to_cn_record(row) for row in read_jsonl(source)]
        for record in records:
            verify_cn_record(record, tag_set)
            tag_counts.update(record["span_tags"])
        if not records:
            raise RuntimeError(f"{source} holds no rows")
        pq.write_table(pa.Table.from_pylist(records, schema=SCHEMA), out_dir / split / "cn-units-0000.parquet")
        counts[split] = len(records)

    board = [to_cn_record(row) for row in read_jsonl(cn_test)]
    for record in board:
        verify_cn_record(record, tag_set)
    with (out_dir / "cn-board.jsonl").open("w", encoding="utf-8") as handle:
        for record in board:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    jp_vocab_path = next(jp_corpus.glob("char-vocab-*.json"))
    cn_train_raws = pq.read_table(out_dir / "train" / "cn-units-0000.parquet", columns=["raw"])["raw"].to_pylist()
    vocab = merge_char_vocab(load_char_vocab(jp_vocab_path), cn_train_raws)
    save_char_vocab(vocab, out_dir / "char-vocab-cjk.json")

    slices = [
        {"path": f"{volume_root}/{jp_version}/{split}/{name}", "split": split, "source": "overture-jp"}
        for split in ("train", "val")
        for name in jp_parts[split]
    ] + [
        {"path": f"{volume_root}/{out_dir.name}/{split}/cn-units-0000.parquet", "split": split, "source": CN_SOURCE}
        for split in ("train", "val")
    ]
    manifest = {
        "corpus_version": out_dir.name,
        "base_corpus_version": jp_version,
        "label_set": LABEL_SET_NAME,
        "note": (
            "Overlay: the JP full slice referenced by volume path plus the CN organizational-unit parts written here. "
            "The loader takes each path as-is when it exists; on the volume both do."
        ),
        "slices": slices,
    }
    (out_dir / "MANIFEST.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    report = {
        "label_set": LABEL_SET_NAME,
        "base_corpus": str(jp_corpus),
        "base_version": jp_version,
        "jp_parts": jp_parts,
        "cn_rows": {**counts, "board": len(board)},
        "cn_span_tags": dict(tag_counts.most_common()),
        "char_vocab": {"jp": len(load_char_vocab(jp_vocab_path)), "cjk": len(vocab)},
        "cn_sources": [str(cn_train), str(cn_val), str(cn_test)],
    }
    (out_dir / "build-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return report


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", maxsplit=1)[0])
    parser.add_argument("--jp-corpus", required=True, help="the local v8-jp-full corpus directory")
    parser.add_argument("--cn-train", required=True)
    parser.add_argument("--cn-val", required=True)
    parser.add_argument("--cn-test", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--volume-root", default=DEFAULT_VOLUME_ROOT, help="where the manifest's paths point")
    parser.add_argument("--jp-version", default=JP_VERSION)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    report = build(
        jp_corpus=Path(args.jp_corpus),
        cn_train=Path(args.cn_train),
        cn_val=Path(args.cn_val),
        cn_test=Path(args.cn_test),
        out_dir=Path(args.out_dir),
        volume_root=args.volume_root,
        jp_version=args.jp_version,
        force=args.force,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
