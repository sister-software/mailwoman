"""Trainer-harness unit tests.

These tests cover the pieces of ``mailwoman_train.tokenizer_train`` that don't need a
corpus on disk: script detection, byte-fallback measurement, UDS file parsing, and the
postcode-shape preservation invariant when UDS literals are present in the SP model.

The full ``train_tokenizer`` end-to-end (with parquet input) is exercised by hand from the
CLI; covering it here would require committing a parquet fixture or training on the real
30 GB shard tree, neither of which is appropriate for fast unit tests.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import sentencepiece as spm  # type: ignore[import-not-found]

from mailwoman_train.tokenizer_train import (
    DEFAULT_USER_DEFINED_SYMBOLS,
    detect_script,
    iter_train_shards,
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
    # Numbers + Latin punctuation around CJK still counts as cjk (90% threshold).
    assert detect_script("〒100-0005 東京都千代田区丸の内") == "cjk"
    # Half-Latin / half-CJK is mixed.
    assert detect_script("Tokyo 東京 City") == "mixed"


def test_detect_script_falls_back_to_other_for_unknown_blocks():
    # Georgian Mkhedruli isn't in our enumerated list — should land on ``other``.
    assert detect_script("თბილისი") == "other"


def test_default_user_defined_symbols_includes_postal_anchors():
    # Sanity: the default list should cover the four format families called out in the
    # v0.5.0 plan plus the postal markers that appear adjacent to postcodes in corpus.
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
                "  ",  # blank-ish; trimmed to nothing, skipped
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
    # With a different seed, the sample changes.
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
    """Train a deliberately-tiny SP model on a one-shot synthetic corpus for unit tests."""
    sample = tmp_path / "raws.txt"
    # Seed the corpus with enough material that SP can hit the tiny vocab budget while still
    # exposing the postcodes we want to keep whole.
    lines = []
    # SP's vocab_size floor = required_chars (1 per byte fallback = 256) + 4 specials +
    # corpus alphabet. Lower bound is ~300, upper bound = pieces SP can extract. Generate a
    # rich-enough synthetic corpus with varied tokens so SP has > 600 candidate pieces.
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
    # Extra filler so the unigram trainer has plenty of distinct pieces to choose from.
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
        # 512 leaves room for 256 byte-fallback pieces + 4 specials + ~50-char alphabet +
        # UDS literals, with headroom for actual unigram pieces. 256 is below the floor.
        vocab_size=512,
        character_coverage=1.0,
        # The synthetic corpus may not contain enough distinct pieces to fill vocab_size;
        # this lets SP cap at the extractable count instead of erroring out.
        hard_vocab_limit=False,
        model_type="unigram",
        byte_fallback=True,
        pad_id=0,
        unk_id=1,
        bos_id=2,
        eos_id=3,
        # Match the harness's space → ▁ substitution so UDS with embedded whitespace fire.
        user_defined_symbols=[u.replace(" ", _SP_WS) for u in (uds or [])],
    )
    spm.SentencePieceTrainer.train(**kwargs)
    return spm.SentencePieceProcessor(model_file=str(prefix.with_suffix(".model")))


def test_user_defined_postcode_kept_whole(tmp_path: Path):
    """Sentencepiece UDS literals must appear as a single piece in the encoding."""
    sp = _train_tiny_sp(tmp_path, uds=["75008", "10118", "SW1A 1AA", "100-0005"])
    # In-corpus postcode that is also a UDS literal.
    pieces = sp.encode_as_pieces("Paris 75008")
    assert "75008" in pieces

    # UDS literal that did NOT appear in training data — should still be guaranteed-whole.
    pieces2 = sp.encode_as_pieces("Tokyo 100-0005")
    assert "100-0005" in pieces2

    # UDS with internal whitespace (UK postcode style). SP renders the whitespace as ``▁``
    # internally — the literal lands as ``SW1A▁1AA`` in the piece stream, which is what the
    # downstream realigner expects (it joins pieces back to chars via byte offsets).
    pieces3 = sp.encode_as_pieces("London SW1A 1AA UK")
    assert f"SW1A{_SP_WS}1AA" in pieces3


def test_measure_byte_fallback_buckets_per_script(tmp_path: Path):
    """Byte-fallback measurement should bucket by detected script and compute rates."""
    sp = _train_tiny_sp(tmp_path)
    # CJK + Cyrillic lines aren't in the tiny synthetic corpus, so they'll byte-fallback;
    # Latin lines are in-corpus and won't.
    lines = [
        "Paris 75008",  # latin, in-vocab
        "Washington DC 20500",  # latin, in-vocab
        "東京都新宿区",  # cjk, will byte-fallback
        "Москва Тверская",  # cyrillic, will byte-fallback
    ]
    r = measure_byte_fallback(sp, lines)
    assert r["overall"]["lines"] == 4
    assert r["overall"]["pieces"] > 0
    # Latin rows should not contribute byte-fallback pieces.
    assert r["per_script"]["latin"]["byte_fallback_pieces"] == 0
    # CJK + Cyrillic rows should contribute byte-fallback pieces.
    assert r["per_script"]["cjk"]["byte_fallback_pieces"] > 0
    assert r["per_script"]["cyrillic"]["byte_fallback_pieces"] > 0
    # Per-script rates land in [0, 1].
    for bucket in r["per_script"].values():
        assert 0.0 <= bucket["rate"] <= 1.0


def test_measure_byte_fallback_empty_input(tmp_path: Path):
    sp = _train_tiny_sp(tmp_path)
    r = measure_byte_fallback(sp, [])
    assert r["overall"]["lines"] == 0
    assert r["overall"]["pieces"] == 0
    assert r["overall"]["byte_fallback_pieces"] == 0
    assert r["overall"]["rate"] == 0.0


def test_iter_train_shards_prefers_manifest(tmp_path: Path):
    """MANIFEST.json shards[] is the source of truth — absolute paths win over glob."""
    # The manifest references a shard in a sibling dir that is *not* under <corpus>/train/,
    # which is exactly the cross-version adapter-addition case (corpus-v0.4.0 → v0.3.0 base
    # paths). The glob would never reach it.
    sibling = tmp_path / "elsewhere"
    sibling.mkdir()
    cross_version_shard = sibling / "part-0000.parquet"
    cross_version_shard.write_bytes(b"")  # contents unused; only path resolution is tested

    corpus = tmp_path / "v0.4.0"
    (corpus / "train").mkdir(parents=True)
    # A local shard that the glob fallback *would* return; the manifest should beat it.
    local_only = corpus / "train" / "part-local.parquet"
    local_only.write_bytes(b"")

    manifest = corpus / "MANIFEST.json"
    manifest.write_text(
        json.dumps(
            {
                "corpus_version": "0.4.0",
                "shards": [
                    {"split": "train", "path": str(cross_version_shard)},
                    {"split": "test", "path": str(corpus / "test" / "part-0000.parquet")},
                ],
            }
        ),
        encoding="utf-8",
    )
    out = iter_train_shards(corpus)
    assert out == [cross_version_shard]


def test_iter_train_shards_falls_back_to_glob_when_manifest_has_no_train_split(tmp_path: Path):
    """A manifest with no train-split entries should not preempt the glob fallback."""
    corpus = tmp_path / "v0.4.0"
    (corpus / "train").mkdir(parents=True)
    local = corpus / "train" / "part-0000.parquet"
    local.write_bytes(b"")
    (corpus / "MANIFEST.json").write_text(
        json.dumps({"shards": [{"split": "test", "path": "/nowhere/test.parquet"}]}),
        encoding="utf-8",
    )
    assert iter_train_shards(corpus) == [local]


def test_iter_train_shards_falls_back_to_glob_when_manifest_missing(tmp_path: Path):
    """Corpora without a MANIFEST (ad-hoc fixtures) keep working via the glob fallback."""
    corpus = tmp_path / "ad-hoc"
    (corpus / "train").mkdir(parents=True)
    a = corpus / "train" / "part-0000.parquet"
    b = corpus / "train" / "part-0001.parquet"
    a.write_bytes(b"")
    b.write_bytes(b"")
    assert iter_train_shards(corpus) == [a, b]


def test_iter_train_shards_raises_when_neither_source_yields_shards(tmp_path: Path):
    """No manifest, no train/ shards → caller-visible FileNotFoundError, not silent empty."""
    corpus = tmp_path / "empty"
    (corpus / "train").mkdir(parents=True)
    with pytest.raises(FileNotFoundError):
        iter_train_shards(corpus)


def test_committed_multi_script_fixture_loads_and_has_balanced_scripts():
    """Sanity-check the in-tree multi-script eval fixture is wellformed."""
    # Resolve relative to the repo root via the test file's own location.
    fixture = (
        Path(__file__).resolve().parent.parent.parent.parent / "data" / "eval" / "multi-script" / "v0.5.0-a0.jsonl"
    )
    assert fixture.exists(), f"missing fixture: {fixture}"
    lines = load_fixture_lines(fixture)
    assert len(lines) >= 30
    # Every line should also have a script tag declared. Re-read raw lines to validate the
    # declared script field matches the detector's call for at least 80% of rows (the slack
    # absorbs the ``other`` / ``mixed`` edge cases the fixture intentionally includes).
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
