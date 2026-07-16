"""#727 stage-2 Phase 2 — span-score export.

Two contracts: (1) `span_scores` rides the ONNX graph as a NAMED output and matches torch;
(2) the segment-transition table ships as a JSON-able sidecar whose axis comes from the file,
never hardcoded (the PLACETYPE_ORDER dual-maintenance class).
"""

import numpy as np
import pytest
import torch

from mailwoman_train.labels import ACTIVE_BIO_LABELS
from mailwoman_train.model import MailwomanCoarseEncoder
from mailwoman_train.package_weights import export_semi_crf_transitions
from mailwoman_train.span_scorer import NUM_SEGMENT_TYPES, SEGMENT_TYPES

_GEOM = dict(
    vocab_size=64,
    hidden_size=16,
    num_hidden_layers=1,
    num_attention_heads=2,
    intermediate_size=32,
    max_position_embeddings=32,
    hidden_dropout_prob=0.0,
    num_labels=len(ACTIVE_BIO_LABELS),
    pad_token_id=0,
)


def _session(path):
    ort = pytest.importorskip("onnxruntime")
    return ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])


def test_span_model_exports_span_scores_output(tmp_path):
    from mailwoman_train.export_onnx import export_to_onnx

    torch.manual_seed(3)
    model = MailwomanCoarseEncoder(**_GEOM, use_span_scorer=True, span_loss_weight=0.5, max_span=4)
    path = export_to_onnx(model, tmp_path / "m.onnx", max_length=32)
    sess = _session(path)
    names = [o.name for o in sess.get_outputs()]
    assert "logits" in names
    assert "span_scores" in names

    ids = np.zeros((1, 32), dtype=np.int64)
    ids[0, :6] = [5, 9, 12, 3, 7, 2]
    mask = np.ones((1, 32), dtype=np.int64)
    onnx_spans = sess.run(["span_scores"], {"input_ids": ids, "attention_mask": mask})[0]
    assert onnx_spans.shape == (1, 32, 4, NUM_SEGMENT_TYPES)

    with torch.no_grad():
        torch_spans = model(input_ids=torch.from_numpy(ids), attention_mask=torch.from_numpy(mask)).span_scores
    np.testing.assert_allclose(onnx_spans, torch_spans.numpy(), atol=1e-3, rtol=1e-3)


def test_spanless_model_export_is_unchanged(tmp_path):
    from mailwoman_train.export_onnx import export_to_onnx

    torch.manual_seed(4)
    model = MailwomanCoarseEncoder(**_GEOM)
    path = export_to_onnx(model, tmp_path / "m.onnx", max_length=32)
    names = [o.name for o in _session(path).get_outputs()]
    assert names == ["logits"]


def test_fetching_only_logits_from_a_span_graph_works(tmp_path):
    # The browser path: never asks for span_scores; must be able to ignore it entirely.
    from mailwoman_train.export_onnx import export_to_onnx

    torch.manual_seed(5)
    model = MailwomanCoarseEncoder(**_GEOM, use_span_scorer=True, span_loss_weight=0.5, max_span=4)
    path = export_to_onnx(model, tmp_path / "m.onnx", max_length=32)
    sess = _session(path)
    ids = np.zeros((1, 32), dtype=np.int64)
    ids[0, 0] = 1
    mask = np.ones((1, 32), dtype=np.int64)
    (logits,) = sess.run(["logits"], {"input_ids": ids, "attention_mask": mask})
    assert logits.shape == (1, 32, len(ACTIVE_BIO_LABELS))


def test_export_semi_crf_transitions_round_trips_the_axis():
    model = MailwomanCoarseEncoder(**_GEOM, use_span_scorer=True, span_loss_weight=0.5, max_span=5)
    with torch.no_grad():
        model.semi_crf.transitions.fill_(0.25)
    sidecar = export_semi_crf_transitions(model)
    assert sidecar is not None
    assert sidecar["segment_types"] == list(SEGMENT_TYPES)
    assert sidecar["max_span"] == 5
    assert len(sidecar["transitions"]) == NUM_SEGMENT_TYPES
    assert len(sidecar["transitions"][0]) == NUM_SEGMENT_TYPES
    assert sidecar["transitions"][1][2] == pytest.approx(0.25)
    assert len(sidecar["start_transitions"]) == NUM_SEGMENT_TYPES
    assert len(sidecar["end_transitions"]) == NUM_SEGMENT_TYPES
    import json

    json.dumps(sidecar)  # must be JSON-serializable as-is


def test_export_semi_crf_transitions_none_for_spanless():
    model = MailwomanCoarseEncoder(**_GEOM)
    assert export_semi_crf_transitions(model) is None
