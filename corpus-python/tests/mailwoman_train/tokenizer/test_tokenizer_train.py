from __future__ import annotations

import json
from pathlib import Path

import pytest
import sentencepiece as spm  # type: ignore[import-not-found]

from mailwoman_train.tokenizer.train import (
    DEFAULT_USER_DEFINED_SYMBOLS,
    detect_script,
    iter_train_files,
    load_fixture_lines,
    measure_byte_fallback,
    parse_user_defined_symbols_file,
    reservoir_sample,
)


def test_detect_script_pure_blocks():
    assert detect_script("1600 Pennsylvania Avenue NW") == "latin"
    assert detect_script("東京都新宿区西新宿") == "cjk"
    assert detect_script("Москва, ул. Тверская") == "cyrillic"
    assert detect_script("Երեւան, Աբովյան") == "armenian"
    assert detect_script("Αθήνα") == "greek"
    assert detect_script("القاهرة") == "arabic"
    assert detect_script("ירושלים") == "hebrew"
    assert detect_script("नई दिल्ली") == "devanagari"
    assert detect_script("กรุงเทพมหานคร") == "thai"


def test_detect_script_handles_mixed_majority():

    assert detect_script("〒100-0005 東京都千代田区丸の内") == "cjk"

    assert detect_script("Tokyo 東京 City") == "mixed"


def test_detect_script_falls_back_to_other_for_unknown_blocks():

    assert detect_script("თბილისი") == "other"


def test_default_user_defined_symbols_includes_postal_anchors():

    assert "NY" in DEFAULT_USER_DEFINED_SYMBOLS
    assert "CA" in DEFAULT_USER_DEFINED_SYMBOLS
    assert "USA" in DEFAULT_USER_DEFINED_SYMBOLS
    assert "France" in DEFAULT_USER_DEFINED_SYMBOLS
    assert "Cedex" in DEFAULT_USER_DEFINED_SYMBOLS
    assert "PO Box" in DEFAULT_USER_DEFINED_SYMBOLS


def test_parse_user_defined_symbols_file(tmp_path: Path):
    p = tmp_path / "uds.txt"
    p.write_text(
        "\n".join(
            [
                "# comment",
                "75008",
                "10001",
                "",
                "SW1A 1AA",
                "  ",
                "100-0005",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    out = parse_user_defined_symbols_file(p)
    assert out == ["75008", "10001", "SW1A 1AA", "100-0005"]


def test_reservoir_sample_size_and_determinism():
    import random as _r

    pool = [str(i) for i in range(1000)]
    rng1 = _r.Random(42)
    rng2 = _r.Random(42)
    s1 = reservoir_sample(iter(pool), 50, rng1)
    s2 = reservoir_sample(iter(pool), 50, rng2)
    assert len(s1) == 50
    assert s1 == s2

    s3 = reservoir_sample(iter(pool), 50, _r.Random(7))
    assert s3 != s1


def test_load_fixture_lines_handles_jsonl_and_text(tmp_path: Path):
    jsonl = tmp_path / "f.jsonl"
    jsonl.write_text(
        '{"raw": "foo"}\n{"text": "bar"}\n{"input": "baz"}\n\n{"raw": "qux"}\n',
        encoding="utf-8",
    )
    assert load_fixture_lines(jsonl) == ["foo", "bar", "baz", "qux"]

    txt = tmp_path / "f.txt"
    txt.write_text("hello\n\nworld\n", encoding="utf-8")
    assert load_fixture_lines(txt) == ["hello", "world"]


_SP_WS = "▁"


def _train_tiny_sp(tmp_path: Path, uds: list[str] | None = None) -> spm.SentencePieceProcessor:
    sample = tmp_path / "raws.txt"

    lines = []

    base_addresses = [
        "1600 Pennsylvania Avenue NW Washington DC 20500",
        "350 Fifth Avenue New York NY 10118",
        "1 Apple Park Way Cupertino CA 95014",
        "15 Rue de Rivoli 75004 Paris France",
        "Paris 75008",
        "PO Box 1234 Anchorage AK 99501",
        "742 Evergreen Terrace Springfield OR 97477",
        "Buffalo Health Center 200 Elmwood Ave Buffalo NY 14222",
        "Saint Petersburg FL 33701",
        "Brooklyn NY 11201",
        "Marais Paris 75004",
        "Lyon 69001 France",
        "Bordeaux 33000",
        "Lille 59000",
    ]

    filler_streets = [
        "Main Street",
        "Oak Avenue",
        "Maple Road",
        "Cedar Lane",
        "Elm Boulevard",
        "Pine Drive",
        "Birch Court",
        "Walnut Place",
        "Sunset Park",
        "Lakeshore Way",
        "Highland Plaza",
        "Riverside Path",
    ]
    for _ in range(200):
        for a in base_addresses:
            lines.append(a)
        for s in filler_streets:
            lines.append(f"{s}, Demo Town, ZZ 00000")
    sample.write_text("\n".join(lines) + "\n", encoding="utf-8")
    prefix = tmp_path / "tk"
    kwargs = dict(
        input=str(sample),
        model_prefix=str(prefix),
        vocab_size=512,
        character_coverage=1.0,
        hard_vocab_limit=False,
        model_type="unigram",
        byte_fallback=True,
        pad_id=0,
        unk_id=1,
        bos_id=2,
        eos_id=3,
        user_defined_symbols=[u.replace(" ", _SP_WS) for u in (uds or [])],
    )
    spm.SentencePieceTrainer.train(**kwargs)
    return spm.SentencePieceProcessor(model_file=str(prefix.with_suffix(".model")))


def test_user_defined_postcode_kept_whole(tmp_path: Path):
    sp = _train_tiny_sp(tmp_path, uds=["75008", "10118", "SW1A 1AA", "100-0005"])

    pieces = sp.encode_as_pieces("Paris 75008")
    assert "75008" in pieces

    pieces2 = sp.encode_as_pieces("Tokyo 100-0005")
    assert "100-0005" in pieces2

    pieces3 = sp.encode_as_pieces("London SW1A 1AA UK")
    assert f"SW1A{_SP_WS}1AA" in pieces3


def test_measure_byte_fallback_buckets_per_script(tmp_path: Path):
    sp = _train_tiny_sp(tmp_path)

    lines = [
        "Paris 75008",
        "Washington DC 20500",
        "東京都新宿区",
        "Москва Тверская",
    ]
    r = measure_byte_fallback(sp, lines)
    assert r["overall"]["lines"] == 4
    assert r["overall"]["pieces"] > 0

    assert r["per_script"]["latin"]["byte_fallback_pieces"] == 0

    assert r["per_script"]["cjk"]["byte_fallback_pieces"] > 0
    assert r["per_script"]["cyrillic"]["byte_fallback_pieces"] > 0

    for bucket in r["per_script"].values():
        assert 0.0 <= bucket["rate"] <= 1.0


def test_measure_byte_fallback_empty_input(tmp_path: Path):
    sp = _train_tiny_sp(tmp_path)
    r = measure_byte_fallback(sp, [])
    assert r["overall"]["lines"] == 0
    assert r["overall"]["pieces"] == 0
    assert r["overall"]["byte_fallback_pieces"] == 0
    assert r["overall"]["rate"] == 0.0


def test_iter_train_files_prefers_manifest(tmp_path: Path):

    sibling = tmp_path / "elsewhere"
    sibling.mkdir()
    cross_version_file = sibling / "part-0000.parquet"
    cross_version_file.write_bytes(b"")

    corpus = tmp_path / "v0.4.0"
    (corpus / "train").mkdir(parents=True)

    local_only = corpus / "train" / "part-local.parquet"
    local_only.write_bytes(b"")

    manifest = corpus / "MANIFEST.json"
    manifest.write_text(
        json.dumps(
            {
                "corpus_version": "0.4.0",
                "slices": [
                    {"split": "train", "path": str(cross_version_file)},
                    {"split": "test", "path": str(corpus / "test" / "part-0000.parquet")},
                ],
            }
        ),
        encoding="utf-8",
    )
    out = iter_train_files(corpus)
    assert out == [cross_version_file]


def test_iter_train_files_falls_back_to_glob_when_manifest_has_no_train_split(tmp_path: Path):
    corpus = tmp_path / "v0.4.0"
    (corpus / "train").mkdir(parents=True)
    local = corpus / "train" / "part-0000.parquet"
    local.write_bytes(b"")
    (corpus / "MANIFEST.json").write_text(
        json.dumps({"slices": [{"split": "test", "path": "/nowhere/test.parquet"}]}),
        encoding="utf-8",
    )
    assert iter_train_files(corpus) == [local]


def test_iter_train_files_falls_back_to_glob_when_manifest_missing(tmp_path: Path):
    corpus = tmp_path / "ad-hoc"
    (corpus / "train").mkdir(parents=True)
    a = corpus / "train" / "part-0000.parquet"
    b = corpus / "train" / "part-0001.parquet"
    a.write_bytes(b"")
    b.write_bytes(b"")
    assert iter_train_files(corpus) == [a, b]


def test_iter_train_files_raises_when_neither_source_yields_files(tmp_path: Path):
    corpus = tmp_path / "empty"
    (corpus / "train").mkdir(parents=True)
    with pytest.raises(FileNotFoundError):
        iter_train_files(corpus)


def test_committed_multi_script_fixture_loads_and_has_balanced_scripts():
    from tests import paths

    fixture = paths.REPO_ROOT / "data" / "eval" / "multi-script" / "v0.5.0-a0.jsonl"
    assert fixture.exists(), f"missing fixture: {fixture}"
    lines = load_fixture_lines(fixture)
    assert len(lines) >= 30

    matches = 0
    total = 0
    with fixture.open("r", encoding="utf-8") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            obj = json.loads(raw)
            declared = obj.get("script")
            assert declared is not None
            total += 1
            if detect_script(obj["raw"]) == declared:
                matches += 1
    assert matches / total >= 0.80, f"only {matches}/{total} fixture rows match detected script"
