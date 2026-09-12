"""Writing an encoder checkpoint and reading one back.

The config dict is the compatibility contract. Every channel and head added since v0.2.0 is a
flag here, written on save and read with a default on load, so an older checkpoint rebuilds with
the behaviour it was trained under rather than with today's defaults. A flag that is written and
not read — or read and not written — silently changes what a resumed run computes, which is why
the two halves live side by side.

These are free functions taking the model (and, for the load, the class) so the encoder module
does not have to carry them. `MailwomanCoarseEncoder.save_pretrained` / `.from_pretrained` stay
the public entry points.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import torch

from ..features.phrase_priors import PHRASE_FEATURE_DIM
from ..labels import ID_TO_LABEL, NUM_LOCALES

if TYPE_CHECKING:
    from .encoder import MailwomanCoarseEncoder


def to_config_dict(model: MailwomanCoarseEncoder) -> dict[str, Any]:
    """The `config.json` payload describing how to rebuild this model."""
    return {
        "model_type": "mailwoman-coarse-encoder",
        "vocab_size": int(model.token_embeddings.num_embeddings),
        "hidden_size": int(model.token_embeddings.embedding_dim),
        "num_hidden_layers": len(model.blocks),
        "num_attention_heads": int(cast(Any, model.blocks[0]).attn.num_heads),
        "intermediate_size": int(cast(Any, model.blocks[0]).ff[0].out_features),
        "max_position_embeddings": int(model.max_position_embeddings),
        "hidden_dropout_prob": float(model.input_dropout.p),
        "num_labels": int(model.num_labels),
        "pad_token_id": int(model.pad_token_id),
        "use_crf": bool(model.use_crf),
        "label_smoothing": float(model.label_smoothing),
        "crf_loss_weight": float(model.crf_loss_weight),
        "crf_normalization": str(model.crf_normalization),
        # v0.4.0: class_weights persisted as a label→weight dict for human
        # readability. None when uniform (no per-class biasing in effect).
        "class_weights": (
            {ID_TO_LABEL[i]: float(w) for i, w in enumerate(model.class_weights.tolist())}
            if isinstance(model.class_weights, torch.Tensor)
            else None
        ),
        # v0.5.0 thread C: phrase-prior conditioning. False on v0.4.0/v0.3.0 weights;
        # True on v0.5.0+. Loaders branch on this flag to materialize the
        # ``phrase_input_projection`` layer.
        "use_phrase_priors": bool(model.use_phrase_priors),
        "phrase_feature_dim": int(model.phrase_feature_dim),
        # PR3 self-conditioning. False/0 on pre-PR3 weights; loaders branch on the flag to
        # materialize locale_head / locale_film at the persisted num_locales width.
        "use_locale_conditioning": bool(model.use_locale_conditioning),
        "num_locales": int(model.num_locales),
        "locale_loss_weight": float(model.locale_loss_weight),
        # Postcode-anchor channel (#239/#240). False/0 on pre-anchor weights; loaders branch on
        # the flag to materialize anchor_projection / anchor_token_embedding at the feature width.
        "use_postcode_anchor": bool(model.use_postcode_anchor),
        "anchor_feature_dim": int(model.anchor_feature_dim),
        "inject_first_token": bool(model.inject_first_token),
        # Gazetteer-anchor channel (#464). False/0 on pre-gazetteer weights.
        "use_gazetteer_anchor": bool(model.use_gazetteer_anchor),
        "gazetteer_feature_dim": int(model.gazetteer_feature_dim),
        # Country-lexicon channel (#1104). False/0 on pre-country weights; loaders branch on the flag
        # to materialize country_projection / country_token_embedding at the feature width.
        "use_country_anchor": bool(model.use_country_anchor),
        "country_feature_dim": int(model.country_feature_dim),
        "use_street_type_anchor": bool(getattr(model, "use_street_type_anchor", False)),
        "street_type_feature_dim": int(getattr(model, "street_type_feature_dim", 0)),
        "use_locality_surface_anchor": bool(getattr(model, "use_locality_surface_anchor", False)),
        "locality_surface_feature_dim": int(getattr(model, "locality_surface_feature_dim", 0)),
        # #1104 homograph-guard scale — MUST serialize so export/reload rebuild with the same scale
        # the checkpoint was trained at (else export defaults to 1.0 and the softening is silently lost).
        "country_ambiguous_scale": float(model.country_ambiguous_scale),
        "use_affix_head": bool(model.use_affix_head),
        # Separate dep-loc head (P-B): MUST serialize so export/from_pretrained rebuild the head and
        # load its trained weights — else the dep-loc columns silently fall back to the classifier.
        "use_deploc_head": bool(getattr(model, "use_deploc_head", False)),
        "use_conventions_loss_mask": bool(model.use_conventions_loss_mask),
        # Span-boundary aux head (#727). Persisted so a resume rebuilds the head; the exported ONNX
        # ignores it (training-only, off the logits path).
        "use_span_boundary_head": bool(model.use_span_boundary_head),
        "span_boundary_loss_weight": float(model.span_boundary_loss_weight),
        "use_span_scorer": bool(model.use_span_scorer),
        "span_loss_weight": float(model.span_loss_weight),
        "span_dim": int(model.span_scorer.start_proj.out_features) if model.span_scorer else 128,
        "max_span": int(model.span_scorer.max_span) if model.span_scorer else 8,
        # CharCNN front-end (#825). False/0 on SentencePiece checkpoints; loaders branch on the flag
        # to materialize the char_cnn module at the persisted char-vocab width + kernel geometry.
        "use_char_embed": bool(model.use_char_embed),
        "char_vocab_size": int(model.char_vocab_size),
        "char_embed_dim": int(model.char_embed_dim),
        "char_kernel_sizes": list(model.char_kernel_sizes),
        "id2label": dict(model.id_to_label),
        "label2id": {label: i for i, label in model.id_to_label.items()},
    }


def save_pretrained(model: MailwomanCoarseEncoder, output_dir: Path | str) -> None:
    """Write the state dict and the rebuild config."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), output_dir / "pytorch_model.bin")
    (output_dir / "config.json").write_text(json.dumps(to_config_dict(model), indent=2) + "\n", encoding="utf-8")


def _constructor_kwargs(cfg: dict[str, Any]) -> dict[str, Any]:
    """Translate a persisted config into constructor arguments.

    Every `.get` default is the behaviour of the release that predates the key, so a checkpoint
    written before a channel existed rebuilds without it rather than with today's default.
    """
    # v8 CJK Phase 2: restore THIS checkpoint's own label map (JSON stringifies int keys).
    # Pre-Phase-2 checkpoints persisted the STAGE3 map, so the fallback is only for configs
    # that predate the id2label key entirely.
    persisted_id2label = cfg.get("id2label")
    id_to_label = {int(k): v for k, v in persisted_id2label.items()} if persisted_id2label else dict(ID_TO_LABEL)
    # v0.4.0: reconstruct the class_weights tensor in label-index order. Absent / None → uniform.
    cw_dict = cfg.get("class_weights")
    cw_tensor: torch.Tensor | None = None
    if cw_dict:
        cw_tensor = torch.tensor(
            [float(cw_dict.get(id_to_label[i], 1.0)) for i in range(cfg["num_labels"])],
            dtype=torch.float32,
        )
    return {
        "vocab_size": cfg["vocab_size"],
        "hidden_size": cfg["hidden_size"],
        "num_hidden_layers": cfg["num_hidden_layers"],
        "num_attention_heads": cfg["num_attention_heads"],
        "intermediate_size": cfg["intermediate_size"],
        "max_position_embeddings": cfg["max_position_embeddings"],
        "hidden_dropout_prob": cfg["hidden_dropout_prob"],
        "num_labels": cfg["num_labels"],
        "pad_token_id": cfg["pad_token_id"],
        # v0.3.0+ fields. Default to v0.2.0 behavior (no CRF, no label smoothing)
        # for backwards-compat with pre-v0.3.0 checkpoints whose config.json predates
        # these keys.
        "use_crf": cfg.get("use_crf", False),
        "label_smoothing": cfg.get("label_smoothing", 0.0),
        "crf_loss_weight": cfg.get("crf_loss_weight", 0.1),
        # v0.4.0+ fields. Default to v0.3.0 behavior (per_sequence, uniform CE).
        "crf_normalization": cfg.get("crf_normalization", "per_sequence"),
        # v0.6.2 diagnostic. Inference-time loading ignores crf_fp32 because the
        # CRF call only fires when crf_loss_weight > 0 (training only).
        "crf_fp32": cfg.get("crf_fp32", False),
        "class_weights": cw_tensor,
        # v0.5.0+ fields. Default to v0.4.0 behavior (no phrase priors).
        "use_phrase_priors": cfg.get("use_phrase_priors", False),
        "phrase_feature_dim": cfg.get("phrase_feature_dim", PHRASE_FEATURE_DIM),
        # PR3 fields. Default off for back-compat with pre-PR3 checkpoints.
        "use_locale_conditioning": cfg.get("use_locale_conditioning", False),
        "num_locales": cfg.get("num_locales", NUM_LOCALES),
        "locale_loss_weight": cfg.get("locale_loss_weight", 0.0),
        # Postcode-anchor fields. Default off for back-compat with pre-anchor checkpoints.
        "use_postcode_anchor": cfg.get("use_postcode_anchor", False),
        "anchor_feature_dim": cfg.get("anchor_feature_dim", NUM_LOCALES + 2),
        "inject_first_token": cfg.get("inject_first_token", False),
        "use_gazetteer_anchor": cfg.get("use_gazetteer_anchor", False),
        # Country-lexicon channel (#1104). Default off for back-compat with pre-country checkpoints.
        "use_country_anchor": cfg.get("use_country_anchor", False),
        "country_feature_dim": cfg.get("country_feature_dim", 2),
        "use_street_type_anchor": cfg.get("use_street_type_anchor", False),
        "street_type_feature_dim": cfg.get("street_type_feature_dim", 1),
        "use_locality_surface_anchor": cfg.get("use_locality_surface_anchor", False),
        "locality_surface_feature_dim": cfg.get("locality_surface_feature_dim", 2),
        "country_ambiguous_scale": cfg.get("country_ambiguous_scale", 1.0),
        "use_affix_head": cfg.get("use_affix_head", False),
        "use_deploc_head": cfg.get("use_deploc_head", False),
        "use_conventions_loss_mask": cfg.get("use_conventions_loss_mask", False),
        # Span-boundary aux head (#727). Default off for back-compat with pre-#727 checkpoints.
        "use_span_scorer": cfg.get("use_span_scorer", False),
        "span_loss_weight": cfg.get("span_loss_weight", 0.0),
        "span_dim": cfg.get("span_dim", 128),
        "max_span": cfg.get("max_span", 8),
        "use_span_boundary_head": cfg.get("use_span_boundary_head", False),
        "span_boundary_loss_weight": cfg.get("span_boundary_loss_weight", 0.0),
        "gazetteer_feature_dim": cfg.get("gazetteer_feature_dim", 5),
        # CharCNN front-end (#825). Default off for back-compat with SentencePiece checkpoints.
        "use_char_embed": cfg.get("use_char_embed", False),
        "char_vocab_size": cfg.get("char_vocab_size", 0),
        "char_embed_dim": cfg.get("char_embed_dim", 64),
        "char_kernel_sizes": tuple(cfg.get("char_kernel_sizes", (3, 4, 5))),
        "id_to_label": id_to_label,
    }


def from_pretrained(encoder_class: type[MailwomanCoarseEncoder], model_dir: Path | str) -> MailwomanCoarseEncoder:
    """Rebuild an encoder from a checkpoint directory and load its weights."""
    model_dir = Path(model_dir)
    cfg = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
    model = encoder_class(**_constructor_kwargs(cfg))
    # map_location="cpu": checkpoints are written on an A100, and torch pickles the storage's
    # device. Without this, loading a GPU-trained checkpoint on a CPU-only box raises
    # "Attempting to deserialize object on a CUDA device" — which is every local grading run
    # (the #727 phase-1 check hit exactly this). CPU is the safe landing spot; callers .to(device).
    # Use weights_only=True if available (torch 2.4+) to avoid pickle-arbitrary-code warning.
    try:
        sd = torch.load(model_dir / "pytorch_model.bin", weights_only=True, map_location="cpu")  # nosec B614 — weights_only=True; our own exported state_dict
    except TypeError:  # pragma: no cover — older torch
        sd = torch.load(model_dir / "pytorch_model.bin", map_location="cpu")  # nosec B614 — same trusted artifact; weights_only=True unavailable pre-2.4
    model.load_state_dict(sd)
    return model
