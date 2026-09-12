"""Building the input layer, the soft-feed channels and the transformer body.

Construction order is a contract, and it binds this module twice. `_init_weights` walks
`self.parameters()`, which yields them in registration order and draws from the global RNG for
each, so the three builders must be called from `__init__` in the order they appear below and
nothing inside one may be reordered. A loaded checkpoint is unaffected — `load_state_dict`
overwrites — but a from-scratch run started after a reorder no longer reproduces one started
before it.

Each stage also records the flags its own code reads: the char-path widths sit with the CharCNN
that composes from them, the channel widths with the projections they size, the CRF settings with
the buffer they register. A flag a reader meets here is one this file's code uses.
"""

from __future__ import annotations

import torch
from torch import nn

from ...labels import ID_TO_LABEL
from ..blocks import EncoderBlock
from ..char_cnn import CharCNNEmbedding
from .soft_feed import soft_feed_channel
from .state import CoarseEncoderState


def resolve_label_map(id_to_label: dict[int, str] | None, num_labels: int) -> dict[int, str]:
    """This model's index → BIO label map.

    `None` takes the module-global STAGE3 map truncated to `num_labels`, which is what every
    checkpoint before the v8 CJK 47-label head carries. A head WIDER than the global map has no
    defensible default and must pass its own. `serialization` writes the resolved map into the
    saved config and reads it back, so a checkpoint always knows its own labels.
    """
    if id_to_label is not None:
        resolved = dict(id_to_label)
        if len(resolved) != num_labels:
            raise ValueError(f"id_to_label carries {len(resolved)} labels but num_labels={num_labels}")
        return resolved
    if num_labels > len(ID_TO_LABEL):
        raise ValueError(f"num_labels={num_labels} exceeds the default label map — pass id_to_label")
    return {i: ID_TO_LABEL[i] for i in range(num_labels)}


class CoarseEncoderConstruct(CoarseEncoderState):
    """The construction half of `MailwomanCoarseEncoder`, in the order `__init__` runs it."""

    def _configure_losses(
        self,
        *,
        num_labels: int,
        use_crf: bool,
        label_smoothing: float,
        crf_loss_weight: float,
        crf_normalization: str,
        crf_fp32: bool,
        class_weights: torch.Tensor | None,
    ) -> None:
        """The CRF decoder settings, label smoothing, and the per-class CE weight buffer.

        CRF NLL is per-sequence and unbounded — at random init it runs ~seq_len*log(num_tags),
        so ~380 against CE's ~3 per token, and equal-weight summing lets CRF gradients drown out
        CE. `crf_loss_weight` 0.1 keeps the CRF a structural regularizer on the emissions;
        weight 1.0 regressed val_macro_f1 from 0.26 to 0.17 by step 750. `crf_normalization`
        "per_token" divides by the real-token count for a magnitude comparable to per-token CE,
        which removes the hand-tuning that weight search needed; "per_sequence" is the older
        behavior. `crf_fp32` forces the CRF forward to fp32 inside a bf16 autocast region, to
        isolate the 33x33 transition matrix with its masked `-inf` entries as a NaN suspect.

        `class_weights` registers as a buffer so it follows the model to GPU and serializes with
        the state dict; `None` leaves uniform weights. This runs before any parameter is
        registered, which is where the buffer's state-dict position comes from.
        """
        self.use_crf = use_crf
        self.label_smoothing = label_smoothing
        self.crf_loss_weight = crf_loss_weight
        if crf_normalization not in ("per_sequence", "per_token"):
            raise ValueError(f"crf_normalization must be 'per_sequence' or 'per_token', got {crf_normalization!r}")
        self.crf_normalization = crf_normalization
        self.crf_fp32 = crf_fp32
        if class_weights is not None:
            if class_weights.shape != (num_labels,):
                raise ValueError(f"class_weights shape {tuple(class_weights.shape)} != expected ({num_labels},)")
            self.register_buffer("class_weights", class_weights.clone().detach().float())
        else:
            self.class_weights = None

    def _build_embeddings(
        self,
        *,
        vocab_size: int,
        hidden_size: int,
        max_position_embeddings: int,
        pad_token_id: int,
        hidden_dropout_prob: float,
        use_phrase_priors: bool,
        phrase_feature_dim: int,
        use_char_embed: bool,
        char_embed_dim: int,
        char_kernel_sizes: tuple[int, ...],
        char_vocab_size: int,
    ) -> None:
        """The input layer: the two embedding tables, the CharCNN front-end, the phrase projection.

        With `use_char_embed` on, a per-token embedding is COMPOSED from the token's characters
        (see `CharCNNEmbedding`) instead of read from a SentencePiece piece-ID table, so a whole
        word ("Čistá") is one token and diacritics never fragment the span. The SentencePiece
        table stays built and unused in that mode, which keeps the pretrain, MLM and save paths
        working unchanged; the ship-slim path drops it once an architecture is chosen.

        `phrase_input_projection` maps `(hidden + phrase_feature_dim) → hidden` so the body's
        stack keeps its declared `hidden_size`. It is None when phrase priors are off and the
        forward path then skips the projection entirely, which is what keeps the v0.4.0 numerics
        reproducible for a back-compat ablation.
        """
        self.pad_token_id = pad_token_id
        self.max_position_embeddings = max_position_embeddings
        self.hidden_size = hidden_size
        self.use_phrase_priors = use_phrase_priors
        self.phrase_feature_dim = int(phrase_feature_dim) if use_phrase_priors else 0
        self.token_embeddings = nn.Embedding(vocab_size, hidden_size, padding_idx=pad_token_id)
        self.position_embeddings = nn.Embedding(max_position_embeddings, hidden_size)
        self.input_dropout = nn.Dropout(hidden_dropout_prob)
        self.input_ln = nn.LayerNorm(hidden_size)
        self.use_char_embed = bool(use_char_embed)
        self.char_embed_dim = int(char_embed_dim)
        self.char_kernel_sizes = tuple(char_kernel_sizes)
        self.char_vocab_size = int(char_vocab_size)
        self.char_cnn: CharCNNEmbedding | None
        if self.use_char_embed:
            if char_vocab_size <= 0:
                raise ValueError("use_char_embed=True requires char_vocab_size > 0")
            self.char_cnn = CharCNNEmbedding(
                char_vocab_size=char_vocab_size,
                char_embed_dim=char_embed_dim,
                hidden_size=hidden_size,
                kernel_sizes=self.char_kernel_sizes,
                pad_char_id=0,
                dropout=hidden_dropout_prob,
            )
        else:
            self.char_cnn = None
        self.phrase_input_projection: nn.Linear | None
        if self.use_phrase_priors:
            self.phrase_input_projection = nn.Linear(hidden_size + self.phrase_feature_dim, hidden_size, bias=True)
        else:
            self.phrase_input_projection = None

    def _build_channels(
        self,
        *,
        hidden_size: int,
        use_postcode_anchor: bool,
        anchor_feature_dim: int,
        inject_first_token: bool,
        use_gazetteer_anchor: bool,
        gazetteer_feature_dim: int,
        use_country_anchor: bool,
        country_feature_dim: int,
        country_ambiguous_scale: float,
        use_street_type_anchor: bool,
        street_type_feature_dim: int,
        use_locality_surface_anchor: bool,
        locality_surface_feature_dim: int,
    ) -> None:
        """The five soft-feed channels, each a projection plus a learned cue vector.

        A disabled channel records width 0 and constructs nothing, so its absence is no projection
        rather than a zero-width one. `inject_first_token` additionally places the pooled anchor at
        position 0 and is meaningful only with the postcode anchor on.

        `country_feature_scale` is a per-dim scale applied to `country_features` BEFORE the
        projection: dim 0 (country_surface) stays 1.0 and dim 1 (country_ambiguous) takes
        `country_ambiguous_scale`, where 1.0 is the hard homograph guard. It registers as a buffer
        so it EXPORTS as a constant into the ONNX graph — inference feeds the raw feature and the
        graph does the scaling.
        """
        self.use_postcode_anchor = use_postcode_anchor
        self.anchor_feature_dim = int(anchor_feature_dim) if use_postcode_anchor else 0
        self.inject_first_token = bool(inject_first_token) and use_postcode_anchor
        self.use_gazetteer_anchor = use_gazetteer_anchor
        self.gazetteer_feature_dim = int(gazetteer_feature_dim) if use_gazetteer_anchor else 0
        self.use_country_anchor = use_country_anchor
        self.country_feature_dim = int(country_feature_dim) if use_country_anchor else 0
        self.country_ambiguous_scale = float(country_ambiguous_scale)
        self.use_street_type_anchor = use_street_type_anchor
        self.street_type_feature_dim = int(street_type_feature_dim) if use_street_type_anchor else 0
        self.use_locality_surface_anchor = use_locality_surface_anchor
        self.locality_surface_feature_dim = int(locality_surface_feature_dim) if use_locality_surface_anchor else 0
        self.anchor_projection, self.anchor_token_embedding = soft_feed_channel(
            self.use_postcode_anchor, self.anchor_feature_dim, hidden_size
        )
        self.gazetteer_projection, self.gazetteer_token_embedding = soft_feed_channel(
            self.use_gazetteer_anchor, self.gazetteer_feature_dim, hidden_size
        )
        self.country_projection, self.country_token_embedding = soft_feed_channel(
            self.use_country_anchor, self.country_feature_dim, hidden_size
        )
        if self.use_country_anchor:
            scale = torch.ones(self.country_feature_dim)
            if self.country_feature_dim >= 2:
                scale[1] = self.country_ambiguous_scale
            self.register_buffer("country_feature_scale", scale, persistent=False)
        else:
            self.country_feature_scale = None
        self.street_type_projection, self.street_type_token_embedding = soft_feed_channel(
            self.use_street_type_anchor, self.street_type_feature_dim, hidden_size
        )
        self.locality_surface_projection, self.locality_surface_token_embedding = soft_feed_channel(
            self.use_locality_surface_anchor, self.locality_surface_feature_dim, hidden_size
        )

    def _build_body(
        self,
        *,
        hidden_size: int,
        num_hidden_layers: int,
        num_attention_heads: int,
        intermediate_size: int,
        hidden_dropout_prob: float,
        num_labels: int,
    ) -> None:
        """The transformer stack, its final norm, and the token classifier."""
        self.blocks = nn.ModuleList(
            [
                EncoderBlock(
                    hidden_size=hidden_size,
                    num_heads=num_attention_heads,
                    ff_intermediate=intermediate_size,
                    dropout=hidden_dropout_prob,
                )
                for _ in range(num_hidden_layers)
            ]
        )
        self.final_ln = nn.LayerNorm(hidden_size)
        self.classifier = nn.Linear(hidden_size, num_labels)
