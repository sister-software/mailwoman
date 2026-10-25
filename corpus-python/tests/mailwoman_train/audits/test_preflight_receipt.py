"""Checks the preflight receipt's key and the GPU run's refusal without a matching receipt."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from mailwoman_train.audits.preflight import (
    PreflightReceiptError,
    preflight_key,
    verify_receipt,
    write_receipt,
)


def _corpus(root: Path, digests: list[str]) -> Path:
    corpus = root / "corpus"
    corpus.mkdir()
    files = [{"path": f"/data/x/train/part-{i}.parquet", "split": "train", "sha256": d} for i, d in enumerate(digests)]
    (corpus / "MANIFEST.json").write_text(json.dumps({"files": files}))
    return corpus


def _config(root: Path, text: str = "train: {}\n") -> Path:
    config = root / "recipe.yaml"
    config.write_text(text)
    return config


def test_the_key_ignores_manifest_order_and_formatting(tmp_path: Path) -> None:
    config = _config(tmp_path)
    corpus = _corpus(tmp_path, ["aa", "bb"])
    before = preflight_key(config, corpus)
    files = json.loads((corpus / "MANIFEST.json").read_text())["files"]
    (corpus / "MANIFEST.json").write_text(json.dumps({"files": list(reversed(files)), "note": "rewritten"}, indent=2))
    assert preflight_key(config, corpus) == before


def test_the_key_moves_with_a_file_digest(tmp_path: Path) -> None:
    config = _config(tmp_path)
    corpus = _corpus(tmp_path, ["aa", "bb"])
    before = preflight_key(config, corpus)
    files = json.loads((corpus / "MANIFEST.json").read_text())["files"]
    files[1]["sha256"] = "cc"
    (corpus / "MANIFEST.json").write_text(json.dumps({"files": files}))
    assert preflight_key(config, corpus) != before


def test_the_key_moves_with_the_config_bytes(tmp_path: Path) -> None:
    config = _config(tmp_path)
    corpus = _corpus(tmp_path, ["aa"])
    before = preflight_key(config, corpus)
    config.write_text("train: {}\n# edited\n")
    assert preflight_key(config, corpus) != before


def test_a_manifest_entry_without_a_digest_cannot_be_bound(tmp_path: Path) -> None:
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    (corpus / "MANIFEST.json").write_text(json.dumps({"files": [{"path": "p", "split": "train"}]}))
    with pytest.raises(ValueError, match="no sha256"):
        preflight_key(_config(tmp_path), corpus)


def test_a_written_receipt_verifies(tmp_path: Path) -> None:
    config, corpus, audits = _config(tmp_path), _corpus(tmp_path, ["aa"]), tmp_path / "audits"
    token = write_receipt(audits, config, corpus, ["corpus_files", "wall_clock"], {})
    verify_receipt(audits, config, corpus, token, ["corpus_files", "wall_clock"])


def test_the_gpu_run_refuses_without_a_token(tmp_path: Path) -> None:
    config, corpus, audits = _config(tmp_path), _corpus(tmp_path, ["aa"]), tmp_path / "audits"
    write_receipt(audits, config, corpus, ["corpus_files"], {})
    with pytest.raises(PreflightReceiptError, match="no preflight token"):
        verify_receipt(audits, config, corpus, "", ["corpus_files"])


def test_the_gpu_run_refuses_a_token_for_other_bytes(tmp_path: Path) -> None:
    config, corpus, audits = _config(tmp_path), _corpus(tmp_path, ["aa"]), tmp_path / "audits"
    token = write_receipt(audits, config, corpus, ["corpus_files"], {})
    config.write_text("train: {max_steps: 1}\n")
    with pytest.raises(PreflightReceiptError, match="other config or manifest bytes"):
        verify_receipt(audits, config, corpus, token, ["corpus_files"])


def test_the_gpu_run_refuses_a_receipt_missing_a_declared_audit(tmp_path: Path) -> None:
    config, corpus, audits = _config(tmp_path), _corpus(tmp_path, ["aa"]), tmp_path / "audits"
    token = write_receipt(audits, config, corpus, ["corpus_files"], {})
    with pytest.raises(PreflightReceiptError, match="validation_coverage"):
        verify_receipt(audits, config, corpus, token, ["corpus_files", "validation_coverage"])


def test_the_gpu_run_refuses_when_the_receipt_file_is_gone(tmp_path: Path) -> None:
    config, corpus, audits = _config(tmp_path), _corpus(tmp_path, ["aa"]), tmp_path / "audits"
    token = write_receipt(audits, config, corpus, ["corpus_files"], {})
    (audits / f"preflight-{token}.json").unlink()
    with pytest.raises(PreflightReceiptError, match="unreadable"):
        verify_receipt(audits, config, corpus, token, ["corpus_files"])
