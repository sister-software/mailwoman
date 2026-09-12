"""Every exportable channel combination reaches ONNX with its inputs named, and refuses when it cannot.

The exporter picks one wrapper per input combination, and the production ship shape — the full
evidence bundle: anchor + gazetteer + country + street-type + locality-surface — had no export test
at all. Only the two simplest wrappers were covered, so a channel that silently stopped reaching
the graph would ship as a model running that channel OFF, which is the #566/#685 trap the
exporter's own guards exist to prevent.

Each case here asserts what a consumer reads: the graph's input NAMES. A runtime feeds by name, so
a missing name is a channel the model was trained with and inference cannot supply.
"""

from __future__ import annotations

import pytest
import torch

from mailwoman_train.labels import ACTIVE_BIO_LABELS, NUM_LOCALES
from mailwoman_train.nn.encoder import MailwomanCoarseEncoder

onnx = pytest.importorskip("onnx")

SEQ = 16
GAZ_DIM = 5
COUNTRY_DIM = 2
STREET_TYPE_DIM = 1
LOCALITY_SURFACE_DIM = 2

BASE_INPUTS = ["input_ids", "attention_mask"]
ANCHOR_INPUTS = ["anchor_features", "anchor_confidence"]
GAZ_INPUTS = ["gazetteer_features", "gazetteer_confidence"]
COUNTRY_INPUTS = ["country_features", "country_confidence"]
BUNDLE_INPUTS = [
    "street_type_features",
    "street_type_confidence",
    "locality_surface_features",
    "locality_surface_confidence",
]


def _model(**flags: object) -> MailwomanCoarseEncoder:
    torch.manual_seed(0)
    return MailwomanCoarseEncoder(
        vocab_size=32,
        hidden_size=32,
        num_hidden_layers=1,
        num_attention_heads=4,
        intermediate_size=64,
        max_position_embeddings=SEQ,
        hidden_dropout_prob=0.0,
        num_labels=len(ACTIVE_BIO_LABELS),
        pad_token_id=0,
        use_crf=False,
        **flags,  # type: ignore[arg-type]
    )


def _graph_input_names(path) -> list[str]:
    return [i.name for i in onnx.load(str(path)).graph.input]


def _graph_output_names(path) -> list[str]:
    return [o.name for o in onnx.load(str(path)).graph.output]


def test_the_anchor_channel_reaches_the_graph(tmp_path) -> None:
    from mailwoman_train.export.onnx import export_to_onnx

    model = _model(use_postcode_anchor=True, anchor_feature_dim=NUM_LOCALES + 2)
    path = export_to_onnx(model, tmp_path / "anchor.onnx", max_length=SEQ)
    assert _graph_input_names(path) == BASE_INPUTS + ANCHOR_INPUTS


def test_the_gazetteer_channel_reaches_the_graph_on_its_own(tmp_path) -> None:
    from mailwoman_train.export.onnx import export_to_onnx

    model = _model(use_gazetteer_anchor=True, gazetteer_feature_dim=GAZ_DIM)
    path = export_to_onnx(model, tmp_path / "gaz.onnx", max_length=SEQ)
    assert _graph_input_names(path) == BASE_INPUTS + GAZ_INPUTS


def test_anchor_and_gazetteer_together_reach_the_graph(tmp_path) -> None:
    from mailwoman_train.export.onnx import export_to_onnx

    model = _model(
        use_postcode_anchor=True,
        anchor_feature_dim=NUM_LOCALES + 2,
        use_gazetteer_anchor=True,
        gazetteer_feature_dim=GAZ_DIM,
    )
    path = export_to_onnx(model, tmp_path / "anchor-gaz.onnx", max_length=SEQ)
    assert _graph_input_names(path) == BASE_INPUTS + ANCHOR_INPUTS + GAZ_INPUTS


def test_the_country_channel_reaches_the_graph_on_top_of_the_other_two(tmp_path) -> None:
    from mailwoman_train.export.onnx import export_to_onnx

    model = _model(
        use_postcode_anchor=True,
        anchor_feature_dim=NUM_LOCALES + 2,
        use_gazetteer_anchor=True,
        gazetteer_feature_dim=GAZ_DIM,
        use_country_anchor=True,
        country_feature_dim=COUNTRY_DIM,
    )
    path = export_to_onnx(model, tmp_path / "country.onnx", max_length=SEQ)
    assert _graph_input_names(path) == BASE_INPUTS + ANCHOR_INPUTS + GAZ_INPUTS + COUNTRY_INPUTS


def test_the_full_evidence_bundle_reaches_the_graph(tmp_path) -> None:
    """The production ship shape: twelve inputs, every trained channel feedable at inference."""
    from mailwoman_train.export.onnx import export_to_onnx

    model = _model(
        use_postcode_anchor=True,
        anchor_feature_dim=NUM_LOCALES + 2,
        use_gazetteer_anchor=True,
        gazetteer_feature_dim=GAZ_DIM,
        use_country_anchor=True,
        country_feature_dim=COUNTRY_DIM,
        use_street_type_anchor=True,
        street_type_feature_dim=STREET_TYPE_DIM,
        use_locality_surface_anchor=True,
        locality_surface_feature_dim=LOCALITY_SURFACE_DIM,
    )
    path = export_to_onnx(model, tmp_path / "bundle.onnx", max_length=SEQ)
    assert _graph_input_names(path) == BASE_INPUTS + ANCHOR_INPUTS + GAZ_INPUTS + COUNTRY_INPUTS + BUNDLE_INPUTS


def test_the_locale_head_adds_a_second_output(tmp_path) -> None:
    """A trained locale head that never reaches the graph is address-system detection nobody can read."""
    from mailwoman_train.export.onnx import export_to_onnx

    model = _model(use_locale_conditioning=True, num_locales=NUM_LOCALES)
    path = export_to_onnx(model, tmp_path / "locale.onnx", max_length=SEQ)
    assert _graph_output_names(path) == ["logits", "locale_logits"]


def test_the_country_channel_alone_refuses_to_export(tmp_path) -> None:
    """Loud, because the alternative is a country-trained model whose ONNX runs country-OFF."""
    from mailwoman_train.export.onnx import export_to_onnx

    model = _model(use_country_anchor=True, country_feature_dim=COUNTRY_DIM)
    with pytest.raises(NotImplementedError, match="use_country_anchor"):
        export_to_onnx(model, tmp_path / "country-only.onnx", max_length=SEQ)


def test_half_the_evidence_bundle_refuses_to_export(tmp_path) -> None:
    """One bundle channel without the other would ship a model that drops a trained channel."""
    from mailwoman_train.export.onnx import export_to_onnx

    model = _model(
        use_postcode_anchor=True,
        anchor_feature_dim=NUM_LOCALES + 2,
        use_gazetteer_anchor=True,
        gazetteer_feature_dim=GAZ_DIM,
        use_country_anchor=True,
        country_feature_dim=COUNTRY_DIM,
        use_street_type_anchor=True,
        street_type_feature_dim=STREET_TYPE_DIM,
    )
    with pytest.raises(NotImplementedError, match="evidence bundle"):
        export_to_onnx(model, tmp_path / "half-bundle.onnx", max_length=SEQ)
