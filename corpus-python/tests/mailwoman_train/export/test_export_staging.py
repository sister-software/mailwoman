"""#2207 — an unverified graph never reaches the output path, and zero parity rows are a refusal.

`export` wrote `model.onnx` and then read the val rows the parity check compares against. A config whose MANIFEST
names parts this host cannot resolve raised at that read, leaving a graph on disk that nothing had compared against
torch — and the v8-cjk-regs export did exactly that, after which the parity read was done from a scratch script.

The second half is quieter: `verify_parity` over an empty sample returns a well-formed metrics dict, so an unreadable
val split printed the same shape a verified export does.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from types import SimpleNamespace

import pytest
import torch

from mailwoman_train.cli.commands.export import _export_char, _require_samples, _staged
from mailwoman_train.labels import ACTIVE_BIO_LABELS
from mailwoman_train.nn.encoder import MailwomanCoarseEncoder

pytest.importorskip("onnxruntime")

UNITS = 8
WINDOW = 3


def _char_model() -> MailwomanCoarseEncoder:
    torch.manual_seed(0)
    return MailwomanCoarseEncoder(
        vocab_size=2,
        hidden_size=16,
        num_hidden_layers=1,
        num_attention_heads=2,
        intermediate_size=32,
        max_position_embeddings=UNITS,
        hidden_dropout_prob=0.0,
        num_labels=len(ACTIVE_BIO_LABELS),
        pad_token_id=0,
        use_crf=False,
        use_char_embed=True,
        char_vocab_size=32,
    )


def _args(out: Path) -> argparse.Namespace:
    return argparse.Namespace(output=str(out), opset=17, parity_samples=4, tolerance=1e-4, config=None, checkpoint="")


def _cfg() -> SimpleNamespace:
    return SimpleNamespace(data=SimpleNamespace(max_units=UNITS, max_unit_width=WINDOW, char_mode="char"))


def test_an_unresolvable_val_split_leaves_no_graph_behind(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import mailwoman_train.data.loader as loader

    def raise_unresolvable(*_args: object, **_kwargs: object):
        raise FileNotFoundError("MANIFEST declares 7 'val' parquet files but 6 are unresolvable")

    monkeypatch.setattr(loader, "iter_batches", raise_unresolvable)

    out = tmp_path / "model.onnx"

    with pytest.raises(FileNotFoundError, match="unresolvable"):
        _export_char(_args(out), _cfg(), _char_model(), out)

    assert not out.exists()
    assert not _staged(out).exists()


def test_zero_parity_rows_refuse_rather_than_report_metrics_over_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import mailwoman_train.data.loader as loader

    monkeypatch.setattr(loader, "iter_batches", lambda *_a, **_k: iter(()))

    out = tmp_path / "model.onnx"

    with pytest.raises(RuntimeError, match="0 val rows"):
        _export_char(_args(out), _cfg(), _char_model(), out)

    assert not out.exists()
    assert not _staged(out).exists()


def test_a_verified_export_lands_at_the_output_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import mailwoman_train.data.loader as loader

    batch = {"char_ids": [[[1] * WINDOW for _ in range(UNITS)]], "attention_mask": [[1] * UNITS]}
    monkeypatch.setattr(loader, "iter_batches", lambda *_a, **_k: iter([batch]))

    out = tmp_path / "model.onnx"

    assert _export_char(_args(out), _cfg(), _char_model(), out) == 0
    assert out.exists()
    assert not _staged(out).exists()


def test_require_samples_reads_an_empty_list_as_a_failure_not_a_pass() -> None:
    with pytest.raises(RuntimeError, match="NOT verified"):
        _require_samples([])

    _require_samples([object()])
