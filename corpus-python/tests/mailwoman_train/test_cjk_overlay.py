"""The v8 CJK overlay builder (#2034): the CN rows in the JP parquet schema, the manifest that references the JP parts
by volume path, and the re-sealed vocabulary."""

from __future__ import annotations

import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from mailwoman_train.build_cjk_overlay import build, merge_char_vocab, to_cn_record, verify_cn_record
from mailwoman_train.build_jp_slice import SCHEMA
from mailwoman_train.char_tokenizer import save_char_vocab
from mailwoman_train.labels import resolve_label_set

TAGS = frozenset(resolve_label_set("stage3-cjk").tags)

CN_ROW = {
    "raw": "赵光三分场二十九队, Inner Mongolia, China",
    "tokens": ["赵", "光", "三", "分", "场", "二", "十", "九", "队", "Inner", "Mongolia", "China"],
    "labels": [
        "B-dependent_locality",
        "I-dependent_locality",
        "B-locality_unit",
        "I-locality_unit",
        "I-locality_unit",
        "I-locality_unit",
        "I-locality_unit",
        "I-locality_unit",
        "I-locality_unit",
        "B-region",
        "I-region",
        "B-country",
    ],
    "span_starts": [0, 2, 11, 27],
    "span_ends": [2, 9, 25, 32],
    "span_tags": ["dependent_locality", "locality_unit", "region", "country"],
    "source": "coarse-placer-cn-units",
}


def write_jsonl(path: Path, rows: list[dict]) -> Path:
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    return path


def make_jp_corpus(root: Path) -> Path:
    corpus = root / "v8-jp-full-2026-08-04"
    for split in ("train", "val"):
        (corpus / split).mkdir(parents=True)
        pq.write_table(
            pa.Table.from_pylist(
                [
                    {
                        "raw": "東京都千代田区丸の内1",
                        "tokens": ["東京都千代田区丸の内1"],
                        "labels": ["B-prefecture"],
                        "span_starts": [0, 3, 7],
                        "span_ends": [3, 7, 10],
                        "span_tags": ["prefecture", "municipality", "district"],
                        "country": "JP",
                        "source": "overture-jp",
                        "register": "native",
                    }
                ],
                schema=SCHEMA,
            ),
            corpus / split / "part-0000.parquet",
        )
    save_char_vocab(
        {
            "<pad>": 0,
            "<unk>": 1,
            "1": 2,
            "丸": 3,
            "京": 4,
            "内": 5,
            "区": 6,
            "千": 7,
            "代": 8,
            "田": 9,
            "東": 10,
            "都": 11,
            "の": 12,
        },
        corpus / "char-vocab-jp-full.json",
    )
    return corpus


def test_cn_record_takes_the_jp_schema_and_a_cn_register() -> None:
    record = to_cn_record(CN_ROW)
    assert record["country"] == "CN"
    assert record["register"] == "cn-units"
    pa.Table.from_pylist([record], schema=SCHEMA)


def test_verify_allows_the_inner_space_of_a_latin_region_and_refuses_a_foreign_tag() -> None:
    verify_cn_record(to_cn_record(CN_ROW), TAGS)
    bad = to_cn_record({**CN_ROW, "span_tags": ["dependent_locality", "farm", "region", "country"]})
    with pytest.raises(RuntimeError, match="outside stage3-cjk"):
        verify_cn_record(bad, TAGS)


def test_merged_vocab_keeps_every_jp_character_and_adds_every_cn_character_once() -> None:
    vocab = merge_char_vocab({"<pad>": 0, "<unk>": 1, "丸": 2, "京": 3}, ["赵光", "光"])
    assert vocab["<pad>"] == 0 and vocab["<unk>"] == 1
    assert set(vocab) == {"<pad>", "<unk>", "丸", "京", "赵", "光"}
    # Code-point order, the same rule build_char_vocab uses, so the artifact is stable.
    assert list(vocab)[2:] == sorted(["丸", "京", "赵", "光"])


def test_build_writes_the_overlay_with_the_jp_parts_referenced_by_volume_path(tmp_path: Path) -> None:
    corpus = make_jp_corpus(tmp_path)
    train = write_jsonl(tmp_path / "train.jsonl", [CN_ROW])
    val = write_jsonl(tmp_path / "val.jsonl", [CN_ROW])
    test = write_jsonl(tmp_path / "test.jsonl", [CN_ROW, CN_ROW])
    out = tmp_path / "v8-cjk-test"

    report = build(
        jp_corpus=corpus,
        cn_train=train,
        cn_val=val,
        cn_test=test,
        out_dir=out,
        volume_root="/data/corpus/versioned",
    )

    manifest = json.loads((out / "MANIFEST.json").read_text(encoding="utf-8"))
    paths = [entry["path"] for entry in manifest["slices"]]
    assert "/data/corpus/versioned/v8-jp-full-2026-08-04/train/part-0000.parquet" in paths
    assert "/data/corpus/versioned/v8-cjk-test/train/cn-units-0000.parquet" in paths
    assert manifest["base_corpus_version"] == "v8-jp-full-2026-08-04"
    assert manifest["label_set"] == "stage3-cjk"

    cn = pq.read_table(out / "train" / "cn-units-0000.parquet").to_pylist()
    assert cn[0]["register"] == "cn-units" and cn[0]["country"] == "CN"
    assert report["cn_rows"] == {"train": 1, "val": 1, "board": 2}
    assert report["cn_span_tags"]["locality_unit"] == 2
    assert report["char_vocab"]["cjk"] > report["char_vocab"]["jp"]
    assert (out / "cn-board.jsonl").read_text(encoding="utf-8").count("\n") == 2
