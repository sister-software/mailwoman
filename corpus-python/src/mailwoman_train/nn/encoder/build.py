"""Building an encoder from a run config, and counting what it holds.

The one place a `Config` is read into constructor arguments. Every `getattr(cfg.model, …)` default
here is the value a recipe that does not name the setting gets, so this file is also the list of
what a recipe may leave out.
"""

from __future__ import annotations

import torch
from torch import nn

from ...config import Config
from ...features.phrase_priors import PHRASE_FEATURE_DIM
from ...labels import NUM_LOCALES
from .model import MailwomanCoarseEncoder


def build_model(cfg: Config, vocab_size: int, pad_token_id: int, char_vocab_size: int = 0) -> MailwomanCoarseEncoder:
    """Instantiate ``MailwomanCoarseEncoder`` with the phase's geometry from ``cfg``.

    ``char_vocab_size`` is the CharCNN char-alphabet size (#825); it's derived from the char vocab at
    load time (like ``vocab_size`` for the SentencePiece path) and only used when
    ``cfg.model.use_char_embed`` is set.
    """
    # v8 CJK Phase 2: the label vocabulary is per-config (data.label_set; "stage3" default keeps
    # every existing recipe byte-identical). The internal consumers of the module-global 33-label
    # maps (CRF init aside — that one is threaded) are flag-restricted features that have never trained
    # against a non-default set; refuse the combination loudly rather than mislabel silently.
    from ...labels import resolve_label_set

    label_set = resolve_label_set(getattr(cfg.data, "label_set", "stage3"))
    if label_set.name != "stage3":
        for flag in (
            "use_conventions_loss_mask",
            "use_affix_head",
            "use_deploc_head",
            "use_span_boundary_head",
            "use_span_scorer",
        ):
            if getattr(cfg.model, flag, False):
                raise ValueError(f"model.{flag} is not supported with data.label_set={label_set.name!r}")

    # v0.4.0: derive the class_weights tensor from cfg.model.class_weights if set.
    # Labels not present in the dict default to weight 1.0 (no change vs uniform).
    cw_dict = getattr(cfg.model, "class_weights", None)
    cw_tensor: torch.Tensor | None = None
    if cw_dict:
        cw_tensor = torch.tensor(
            [float(cw_dict.get(label, 1.0)) for label in label_set.bio_labels],
            dtype=torch.float32,
        )
    return MailwomanCoarseEncoder(
        vocab_size=vocab_size,
        hidden_size=cfg.model.hidden_size,
        num_hidden_layers=cfg.model.num_hidden_layers,
        num_attention_heads=cfg.model.num_attention_heads,
        intermediate_size=cfg.model.intermediate_size,
        max_position_embeddings=cfg.model.max_position_embeddings,
        hidden_dropout_prob=cfg.model.hidden_dropout_prob,
        num_labels=len(label_set.bio_labels),
        id_to_label=label_set.id_to_label,
        pad_token_id=pad_token_id,
        # v0.3.0 defaults — surface in cfg.model if/when ablation studies need to vary.
        use_crf=getattr(cfg.model, "use_crf", True),
        label_smoothing=getattr(cfg.model, "label_smoothing", 0.1),
        crf_loss_weight=getattr(cfg.model, "crf_loss_weight", 0.1),
        # v0.4.0 additions.
        crf_normalization=getattr(cfg.model, "crf_normalization", "per_sequence"),
        # v0.6.2 diagnostic.
        crf_fp32=getattr(cfg.model, "crf_fp32", False),
        class_weights=cw_tensor,
        # v0.5.0 thread C additions.
        use_phrase_priors=getattr(cfg.model, "use_phrase_priors", False),
        phrase_feature_dim=getattr(cfg.model, "phrase_feature_dim", PHRASE_FEATURE_DIM),
        # PR3 self-conditioning. num_locales is derived from labels.NUM_LOCALES (single source of
        # truth), never from the yaml, so the head width and the aux-target vocabulary can't drift.
        use_locale_conditioning=getattr(cfg.model, "use_locale_conditioning", False),
        num_locales=NUM_LOCALES,
        locale_loss_weight=getattr(cfg.model, "locale_loss_weight", 0.0),
        # Postcode-anchor channel (#239/#240). anchor_feature_dim derived from NUM_LOCALES (posterior
        # over the locale set) + 2 (centroid) — single source of truth, can't drift from the loader.
        use_postcode_anchor=getattr(cfg.model, "use_postcode_anchor", False),
        anchor_feature_dim=NUM_LOCALES + 2,
        inject_first_token=getattr(cfg.model, "inject_first_token", False),
        # Gazetteer-anchor channel (#464). feature_dim follows the lexicon's slot count (the loader
        # validates the JSON's feature_dim against this at startup via the trainer).
        use_gazetteer_anchor=getattr(cfg.model, "use_gazetteer_anchor", False),
        gazetteer_feature_dim=getattr(cfg.model, "gazetteer_feature_dim", 5),
        # Country-lexicon channel (#1104). feature_dim follows the country lexicon's emitted width (2).
        use_country_anchor=getattr(cfg.model, "use_country_anchor", False),
        country_feature_dim=getattr(cfg.model, "country_feature_dim", 2),
        use_street_type_anchor=getattr(cfg.model, "use_street_type_anchor", False),
        street_type_feature_dim=getattr(cfg.model, "street_type_feature_dim", 1),
        use_locality_surface_anchor=getattr(cfg.model, "use_locality_surface_anchor", False),
        locality_surface_feature_dim=getattr(cfg.model, "locality_surface_feature_dim", 2),
        country_ambiguous_scale=getattr(cfg.model, "country_ambiguous_scale", 1.0),
        # Dedicated affix head (#492).
        use_affix_head=getattr(cfg.model, "use_affix_head", False),
        use_deploc_head=getattr(cfg.model, "use_deploc_head", False),
        use_conventions_loss_mask=getattr(cfg.model, "use_conventions_loss_mask", False),
        # Span-boundary aux head (#727, GLiNER-lite probe).
        use_span_boundary_head=getattr(cfg.model, "use_span_boundary_head", False),
        span_boundary_loss_weight=getattr(cfg.model, "span_boundary_loss_weight", 0.0),
        use_span_scorer=getattr(cfg.model, "use_span_scorer", False),
        span_loss_weight=getattr(cfg.model, "span_loss_weight", 0.0),
        span_dim=getattr(cfg.model, "span_dim", 128),
        max_span=getattr(cfg.model, "max_span", 8),
        # CharCNN front-end (#825). char_vocab_size threaded from the loader; the rest from cfg.model.
        use_char_embed=getattr(cfg.model, "use_char_embed", False),
        char_vocab_size=char_vocab_size,
        char_embed_dim=getattr(cfg.model, "char_embed_dim", 64),
        char_kernel_sizes=tuple(getattr(cfg.model, "char_kernel_sizes", (3, 4, 5))),
    )


def model_param_count(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters())
