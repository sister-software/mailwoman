"""A char-path model exports behind `char_ids` + `attention_mask` and no `input_ids`, and the ONNX graph agrees with
PyTorch on the logits. The graph is what `@mailwoman/neural`'s char-mode runner will feed (#2164, step 1)."""

from __future__ import annotations

import numpy as np
import pytest
import torch

from mailwoman_train.labels import ACTIVE_BIO_LABELS
from mailwoman_train.model import MailwomanCoarseEncoder

ort = pytest.importorskip("onnxruntime")

UNITS = 16
WINDOW = 5
CHAR_VOCAB = 64


def _char_model() -> MailwomanCoarseEncoder:
    torch.manual_seed(0)
    return MailwomanCoarseEncoder(
        vocab_size=2,
        hidden_size=32,
        num_hidden_layers=1,
        num_attention_heads=4,
        intermediate_size=64,
        max_position_embeddings=UNITS,
        hidden_dropout_prob=0.0,
        num_labels=len(ACTIVE_BIO_LABELS),
        pad_token_id=0,
        use_crf=False,
        use_char_embed=True,
        char_vocab_size=CHAR_VOCAB,
    )


def test_char_model_exports_char_ids_and_no_input_ids(tmp_path):
    from mailwoman_train.export_onnx import export_to_onnx

    path = export_to_onnx(_char_model(), tmp_path / "char.onnx", max_length=UNITS, char_window=WINDOW)
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])

    inputs = {node.name: node.shape for node in session.get_inputs()}
    assert set(inputs) == {"char_ids", "attention_mask"}
    assert inputs["char_ids"][2] == WINDOW
    assert [node.name for node in session.get_outputs()] == ["logits"]


def test_char_model_export_refuses_without_the_window(tmp_path):
    from mailwoman_train.export_onnx import export_to_onnx

    with pytest.raises(ValueError, match="char_window"):
        export_to_onnx(_char_model(), tmp_path / "char.onnx", max_length=UNITS)


def test_char_parity_holds_on_random_units(tmp_path):
    from mailwoman_train.export_onnx import export_to_onnx, verify_char_parity

    model = _char_model()
    path = export_to_onnx(model, tmp_path / "char.onnx", max_length=UNITS, char_window=WINDOW)
    rng = np.random.default_rng(0)
    samples = []
    for _ in range(4):
        real = int(rng.integers(3, UNITS))
        chars = rng.integers(2, CHAR_VOCAB, size=(UNITS, WINDOW))
        chars[real:] = 0
        mask = [1] * real + [0] * (UNITS - real)
        samples.append((chars.tolist(), mask))

    metrics = verify_char_parity(model, path, samples, atol=1e-4)
    assert metrics["samples"] == 4
    assert metrics["max_abs_diff"] <= 1e-4
