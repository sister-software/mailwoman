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
        "class_weights": (
            {ID_TO_LABEL[i]: float(w) for i, w in enumerate(model.class_weights.tolist())}
            if isinstance(model.class_weights, torch.Tensor)
            else None
        ),
        "use_phrase_priors": bool(model.use_phrase_priors),
        "phrase_feature_dim": int(model.phrase_feature_dim),
        "use_locale_conditioning": bool(model.use_locale_conditioning),
        "num_locales": int(model.num_locales),
        "locale_loss_weight": float(model.locale_loss_weight),
        "use_postcode_anchor": bool(model.use_postcode_anchor),
        "anchor_feature_dim": int(model.anchor_feature_dim),
        "inject_first_token": bool(model.inject_first_token),
        "use_gazetteer_anchor": bool(model.use_gazetteer_anchor),
        "gazetteer_feature_dim": int(model.gazetteer_feature_dim),
        "use_country_anchor": bool(model.use_country_anchor),
        "country_feature_dim": int(model.country_feature_dim),
        "use_street_type_anchor": bool(getattr(model, "use_street_type_anchor", False)),
        "street_type_feature_dim": int(getattr(model, "street_type_feature_dim", 0)),
        "use_locality_surface_anchor": bool(getattr(model, "use_locality_surface_anchor", False)),
        "locality_surface_feature_dim": int(getattr(model, "locality_surface_feature_dim", 0)),
        "country_ambiguous_scale": float(model.country_ambiguous_scale),
        "use_affix_head": bool(model.use_affix_head),
        "use_deploc_head": bool(getattr(model, "use_deploc_head", False)),
        "use_conventions_loss_mask": bool(model.use_conventions_loss_mask),
        "use_span_boundary_head": bool(model.use_span_boundary_head),
        "span_boundary_loss_weight": float(model.span_boundary_loss_weight),
        "use_span_scorer": bool(model.use_span_scorer),
        "span_loss_weight": float(model.span_loss_weight),
        "span_dim": int(model.span_scorer.start_proj.out_features) if model.span_scorer else 128,
        "max_span": int(model.span_scorer.max_span) if model.span_scorer else 8,
        "use_char_embed": bool(model.use_char_embed),
        "char_vocab_size": int(model.char_vocab_size),
        "char_embed_dim": int(model.char_embed_dim),
        "char_kernel_sizes": list(model.char_kernel_sizes),
        "id2label": dict(model.id_to_label),
        "label2id": {label: i for i, label in model.id_to_label.items()},
    }


def save_pretrained(model: MailwomanCoarseEncoder, output_dir: Path | str) -> None:
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), output_dir / "pytorch_model.bin")
    (output_dir / "config.json").write_text(json.dumps(to_config_dict(model), indent=2) + "\n", encoding="utf-8")


def _constructor_kwargs(cfg: dict[str, Any]) -> dict[str, Any]:

    persisted_id2label = cfg.get("id2label")
    id_to_label = {int(k): v for k, v in persisted_id2label.items()} if persisted_id2label else dict(ID_TO_LABEL)

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
        "use_crf": cfg.get("use_crf", False),
        "label_smoothing": cfg.get("label_smoothing", 0.0),
        "crf_loss_weight": cfg.get("crf_loss_weight", 0.1),
        "crf_normalization": cfg.get("crf_normalization", "per_sequence"),
        "crf_fp32": cfg.get("crf_fp32", False),
        "class_weights": cw_tensor,
        "use_phrase_priors": cfg.get("use_phrase_priors", False),
        "phrase_feature_dim": cfg.get("phrase_feature_dim", PHRASE_FEATURE_DIM),
        "use_locale_conditioning": cfg.get("use_locale_conditioning", False),
        "num_locales": cfg.get("num_locales", NUM_LOCALES),
        "locale_loss_weight": cfg.get("locale_loss_weight", 0.0),
        "use_postcode_anchor": cfg.get("use_postcode_anchor", False),
        "anchor_feature_dim": cfg.get("anchor_feature_dim", NUM_LOCALES + 2),
        "inject_first_token": cfg.get("inject_first_token", False),
        "use_gazetteer_anchor": cfg.get("use_gazetteer_anchor", False),
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
        "use_span_scorer": cfg.get("use_span_scorer", False),
        "span_loss_weight": cfg.get("span_loss_weight", 0.0),
        "span_dim": cfg.get("span_dim", 128),
        "max_span": cfg.get("max_span", 8),
        "use_span_boundary_head": cfg.get("use_span_boundary_head", False),
        "span_boundary_loss_weight": cfg.get("span_boundary_loss_weight", 0.0),
        "gazetteer_feature_dim": cfg.get("gazetteer_feature_dim", 5),
        "use_char_embed": cfg.get("use_char_embed", False),
        "char_vocab_size": cfg.get("char_vocab_size", 0),
        "char_embed_dim": cfg.get("char_embed_dim", 64),
        "char_kernel_sizes": tuple(cfg.get("char_kernel_sizes", (3, 4, 5))),
        "id_to_label": id_to_label,
    }


def from_pretrained(encoder_class: type[MailwomanCoarseEncoder], model_dir: Path | str) -> MailwomanCoarseEncoder:
    model_dir = Path(model_dir)
    cfg = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
    model = encoder_class(**_constructor_kwargs(cfg))

    try:
        sd = torch.load(model_dir / "pytorch_model.bin", weights_only=True, map_location="cpu")  # nosec B614
    except TypeError:
        sd = torch.load(model_dir / "pytorch_model.bin", map_location="cpu")  # nosec B614
    model.load_state_dict(sd)
    return model
