"""What `MailwomanCoarseEncoder.__init__` establishes, declared once for every part that reads it.

The encoder's methods live in several modules and each reads attributes the constructor set. One
declaration here gives every part the same view of what exists and what type it holds, so a method
can sit beside the methods it belongs with rather than beside the assignments it happens to read.

Nothing here assigns. A bare annotation creates no class attribute, so `nn.Module.__setattr__`
still sees the constructor's assignment as the first one and registers each parameter, buffer and
submodule exactly as it would with the whole class in one file.
"""

from __future__ import annotations

import torch
from torch import nn

from ..char_cnn import CharCNNEmbedding
from ..crf import LinearChainCRF
from ..span_scorer import SemiMarkovCRF, SpanScorer


class CoarseEncoderState(nn.Module):
    """The attribute surface `MailwomanCoarseEncoder`'s methods share.

    The register_buffer names are typed here for the same reason they were typed on the class:
    without a declaration mypy reads them as the `Tensor | Module` union torch's `__setattr__`
    typing produces for an undeclared module attribute.
    """

    # Geometry and label space.
    pad_token_id: int
    max_position_embeddings: int
    hidden_size: int
    num_labels: int
    id_to_label: dict[int, str]

    # Embeddings, body, classifier.
    token_embeddings: nn.Embedding
    position_embeddings: nn.Embedding
    input_dropout: nn.Dropout
    input_ln: nn.LayerNorm
    blocks: nn.ModuleList
    final_ln: nn.LayerNorm
    classifier: nn.Linear

    # CharCNN front-end.
    use_char_embed: bool
    char_embed_dim: int
    char_kernel_sizes: tuple[int, ...]
    char_vocab_size: int
    char_cnn: CharCNNEmbedding | None

    # Phrase priors.
    use_phrase_priors: bool
    phrase_feature_dim: int
    phrase_input_projection: nn.Linear | None

    # Soft-feed channels. Each is a projection plus a cue embedding, both None when its flag is off.
    use_postcode_anchor: bool
    anchor_feature_dim: int
    inject_first_token: bool
    anchor_projection: nn.Linear | None
    anchor_token_embedding: nn.Parameter | None
    use_gazetteer_anchor: bool
    gazetteer_feature_dim: int
    gazetteer_projection: nn.Linear | None
    gazetteer_token_embedding: nn.Parameter | None
    use_country_anchor: bool
    country_feature_dim: int
    country_ambiguous_scale: float
    country_projection: nn.Linear | None
    country_token_embedding: nn.Parameter | None
    country_feature_scale: torch.Tensor | None
    use_street_type_anchor: bool
    street_type_feature_dim: int
    street_type_projection: nn.Linear | None
    street_type_token_embedding: nn.Parameter | None
    use_locality_surface_anchor: bool
    locality_surface_feature_dim: int
    locality_surface_projection: nn.Linear | None
    locality_surface_token_embedding: nn.Parameter | None

    # Losses and the CRF.
    use_crf: bool
    label_smoothing: float
    crf_loss_weight: float
    crf_normalization: str
    crf_fp32: bool
    class_weights: torch.Tensor | None
    crf: LinearChainCRF | None

    # Locale self-conditioning.
    use_locale_conditioning: bool
    num_locales: int
    locale_loss_weight: float
    locale_head: nn.Linear | None
    locale_film: nn.Linear | None

    # Merge heads: their logits replace columns of the classifier's output.
    use_conventions_loss_mask: bool
    conventions_forbidden: torch.Tensor
    use_affix_head: bool
    affix_head: nn.Sequential
    affix_label_ids: torch.Tensor
    affix_target_lut: torch.Tensor
    use_deploc_head: bool
    deploc_head: nn.Sequential
    deploc_label_ids: torch.Tensor

    # Structured heads: they score or decode the classifier's output, replacing none of it.
    use_span_boundary_head: bool
    span_boundary_loss_weight: float
    span_boundary_head: nn.Linear
    bio_is_begin: torch.Tensor
    bio_is_inside: torch.Tensor
    use_span_scorer: bool
    span_loss_weight: float
    span_scorer: SpanScorer | None
    semi_crf: SemiMarkovCRF | None
