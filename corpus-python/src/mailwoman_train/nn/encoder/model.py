from __future__ import annotations

from pathlib import Path

import torch
from torch import nn

from ...features.phrase_priors import PHRASE_FEATURE_DIM
from ...labels import NUM_LOCALES
from .. import serialization
from .channels import CoarseEncoderChannels
from .construct import CoarseEncoderConstruct, resolve_label_map
from .decode import CoarseEncoderDecode
from .heads import CoarseEncoderHeads
from .losses import CoarseEncoderLosses
from .output import CoarseEncoderOutput
from .soft_feed import soft_feed_channel

_CoarseEncoderOutput = CoarseEncoderOutput
_soft_feed_channel = soft_feed_channel


class MailwomanCoarseEncoder(
    CoarseEncoderConstruct,
    CoarseEncoderHeads,
    CoarseEncoderChannels,
    CoarseEncoderLosses,
    CoarseEncoderDecode,
):
    def __init__(
        self,
        *,
        vocab_size: int,
        hidden_size: int,
        num_hidden_layers: int,
        num_attention_heads: int,
        intermediate_size: int,
        max_position_embeddings: int,
        hidden_dropout_prob: float,
        num_labels: int,
        pad_token_id: int,
        use_crf: bool = True,
        label_smoothing: float = 0.1,
        crf_loss_weight: float = 0.1,
        crf_normalization: str = "per_sequence",
        crf_fp32: bool = False,
        class_weights: torch.Tensor | None = None,
        use_phrase_priors: bool = False,
        phrase_feature_dim: int = PHRASE_FEATURE_DIM,
        use_locale_conditioning: bool = False,
        num_locales: int = NUM_LOCALES,
        locale_loss_weight: float = 0.0,
        use_postcode_anchor: bool = False,
        anchor_feature_dim: int = NUM_LOCALES + 2,
        inject_first_token: bool = False,
        use_gazetteer_anchor: bool = False,
        gazetteer_feature_dim: int = 5,
        use_country_anchor: bool = False,
        country_feature_dim: int = 2,
        country_ambiguous_scale: float = 1.0,
        use_street_type_anchor: bool = False,
        street_type_feature_dim: int = 1,
        use_locality_surface_anchor: bool = False,
        locality_surface_feature_dim: int = 2,
        use_affix_head: bool = False,
        use_deploc_head: bool = False,
        use_conventions_loss_mask: bool = False,
        use_span_boundary_head: bool = False,
        span_boundary_loss_weight: float = 0.0,
        use_span_scorer: bool = False,
        span_loss_weight: float = 0.0,
        span_dim: int = 128,
        max_span: int = 8,
        use_char_embed: bool = False,
        char_vocab_size: int = 0,
        char_embed_dim: int = 64,
        char_kernel_sizes: tuple[int, ...] = (3, 4, 5),
        id_to_label: dict[int, str] | None = None,
    ) -> None:
        super().__init__()
        self.num_labels = num_labels
        self.id_to_label = resolve_label_map(id_to_label, num_labels)
        self._configure_losses(
            num_labels=num_labels,
            use_crf=use_crf,
            label_smoothing=label_smoothing,
            crf_loss_weight=crf_loss_weight,
            crf_normalization=crf_normalization,
            crf_fp32=crf_fp32,
            class_weights=class_weights,
        )
        self._build_embeddings(
            vocab_size=vocab_size,
            hidden_size=hidden_size,
            max_position_embeddings=max_position_embeddings,
            pad_token_id=pad_token_id,
            hidden_dropout_prob=hidden_dropout_prob,
            use_phrase_priors=use_phrase_priors,
            phrase_feature_dim=phrase_feature_dim,
            use_char_embed=use_char_embed,
            char_embed_dim=char_embed_dim,
            char_kernel_sizes=char_kernel_sizes,
            char_vocab_size=char_vocab_size,
        )
        self._build_channels(
            hidden_size=hidden_size,
            use_postcode_anchor=use_postcode_anchor,
            anchor_feature_dim=anchor_feature_dim,
            inject_first_token=inject_first_token,
            use_gazetteer_anchor=use_gazetteer_anchor,
            gazetteer_feature_dim=gazetteer_feature_dim,
            use_country_anchor=use_country_anchor,
            country_feature_dim=country_feature_dim,
            country_ambiguous_scale=country_ambiguous_scale,
            use_street_type_anchor=use_street_type_anchor,
            street_type_feature_dim=street_type_feature_dim,
            use_locality_surface_anchor=use_locality_surface_anchor,
            locality_surface_feature_dim=locality_surface_feature_dim,
        )
        self._build_body(
            hidden_size=hidden_size,
            num_hidden_layers=num_hidden_layers,
            num_attention_heads=num_attention_heads,
            intermediate_size=intermediate_size,
            hidden_dropout_prob=hidden_dropout_prob,
            num_labels=num_labels,
        )
        self._build_heads(
            hidden_size=hidden_size,
            num_labels=num_labels,
            use_locale_conditioning=use_locale_conditioning,
            num_locales=num_locales,
            locale_loss_weight=locale_loss_weight,
            use_conventions_loss_mask=use_conventions_loss_mask,
            use_affix_head=use_affix_head,
            use_deploc_head=use_deploc_head,
            use_span_boundary_head=use_span_boundary_head,
            span_boundary_loss_weight=span_boundary_loss_weight,
            use_span_scorer=use_span_scorer,
            span_loss_weight=span_loss_weight,
            span_dim=span_dim,
            max_span=max_span,
            use_crf=use_crf,
        )

        self._init_weights()

    def forward(
        self,
        input_ids: torch.Tensor | None = None,
        attention_mask: torch.Tensor | None = None,
        labels: torch.Tensor | None = None,
        phrase_features: torch.Tensor | None = None,
        locale_ids: torch.Tensor | None = None,
        anchor_features: torch.Tensor | None = None,
        anchor_confidence: torch.Tensor | None = None,
        gazetteer_features: torch.Tensor | None = None,
        gazetteer_confidence: torch.Tensor | None = None,
        country_features: torch.Tensor | None = None,
        country_confidence: torch.Tensor | None = None,
        street_type_features: torch.Tensor | None = None,
        street_type_confidence: torch.Tensor | None = None,
        locality_surface_features: torch.Tensor | None = None,
        locality_surface_confidence: torch.Tensor | None = None,
        char_ids: torch.Tensor | None = None,
    ) -> _CoarseEncoderOutput:
        h = self._embed_inputs(
            input_ids=input_ids,
            char_ids=char_ids,
            phrase_features=phrase_features,
            anchor_features=anchor_features,
            anchor_confidence=anchor_confidence,
            gazetteer_features=gazetteer_features,
            gazetteer_confidence=gazetteer_confidence,
            country_features=country_features,
            country_confidence=country_confidence,
            street_type_features=street_type_features,
            street_type_confidence=street_type_confidence,
            locality_surface_features=locality_surface_features,
            locality_surface_confidence=locality_surface_confidence,
        )
        bsz, seq = h.shape[0], h.shape[1]
        return self._encode_and_score(
            h,
            attention_mask=attention_mask,
            labels=labels,
            locale_ids=locale_ids,
            gazetteer_features=gazetteer_features,
            bsz=bsz,
            seq=seq,
        )

    def _encode_and_score(
        self,
        h: torch.Tensor,
        *,
        attention_mask: torch.Tensor | None,
        labels: torch.Tensor | None,
        locale_ids: torch.Tensor | None,
        gazetteer_features: torch.Tensor | None,
        bsz: int,
        seq: int,
    ) -> _CoarseEncoderOutput:

        kpm: torch.Tensor | None = None
        if attention_mask is not None:
            kpm = attention_mask == 0

        for block in self.blocks:
            h = block(h, key_padding_mask=kpm)

        h = self.final_ln(h)

        locale_logits: torch.Tensor | None = None
        if self.use_locale_conditioning and self.locale_head is not None and self.locale_film is not None:
            if attention_mask is not None:
                m = attention_mask.to(torch.float32).unsqueeze(-1)
                pooled = (h.float() * m).sum(dim=1) / m.sum(dim=1).clamp(min=1.0)
            else:
                pooled = h.float().mean(dim=1)
            pooled = pooled.to(h.dtype)
            locale_logits = self.locale_head(pooled)

            film = self.locale_film(pooled)
            gamma = film[..., : self.hidden_size]
            beta = film[..., self.hidden_size :]
            h = (1.0 + gamma).unsqueeze(1) * h + beta.unsqueeze(1)

        logits = self.classifier(h)

        affix_logits: torch.Tensor | None = None
        if self.use_affix_head:
            gaz = gazetteer_features
            if gaz is None:
                gaz = torch.zeros(bsz, seq, self.gazetteer_feature_dim or 5, dtype=h.dtype, device=h.device)
            affix_logits = self.affix_head(torch.cat([h, gaz.to(h.dtype)], dim=-1))

            logits = logits.clone()
            logits[:, :, self.affix_label_ids] = affix_logits[:, :, 1:]

        if self.use_deploc_head:
            deploc_logits = self.deploc_head(h)
            logits = logits.clone()
            logits[:, :, self.deploc_label_ids] = deploc_logits[:, :, 1:]

        loss, span_scores_out = self._compute_losses(
            hidden=h,
            logits=logits,
            labels=labels,
            attention_mask=attention_mask,
            locale_ids=locale_ids,
            locale_logits=locale_logits,
            affix_logits=affix_logits,
        )
        return _CoarseEncoderOutput(logits=logits, loss=loss, locale_logits=locale_logits, span_scores=span_scores_out)

    def forward_mlm(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor | None = None,
        mlm_labels: torch.Tensor | None = None,
    ) -> _CoarseEncoderOutput:
        bsz, seq = input_ids.shape
        pos = torch.arange(seq, device=input_ids.device).unsqueeze(0).expand(bsz, seq)
        h = self.token_embeddings(input_ids) + self.position_embeddings(pos)
        h = self.input_dropout(self.input_ln(h))
        kpm: torch.Tensor | None = None
        if attention_mask is not None:
            kpm = attention_mask == 0
        for block in self.blocks:
            h = block(h, key_padding_mask=kpm)
        h = self.final_ln(h)

        vocab_size = self.token_embeddings.num_embeddings
        lm_logits = h @ self.token_embeddings.weight.t()
        loss: torch.Tensor | None = None
        if mlm_labels is not None:
            loss = nn.functional.cross_entropy(
                lm_logits.view(-1, vocab_size),
                mlm_labels.view(-1),
                ignore_index=-100,
            )
        return _CoarseEncoderOutput(lm_logits, loss)

    def save_pretrained(self, output_dir: Path | str) -> None:
        serialization.save_pretrained(self, output_dir)

    @classmethod
    def from_pretrained(cls, model_dir: Path | str) -> MailwomanCoarseEncoder:
        return serialization.from_pretrained(cls, model_dir)
