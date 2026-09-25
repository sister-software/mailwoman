from __future__ import annotations

import torch

from .soft_feed import inject_soft_feed
from .state import CoarseEncoderState

_inject_soft_feed = inject_soft_feed


class CoarseEncoderChannels(CoarseEncoderState):
    def _embed_inputs(
        self,
        *,
        input_ids: torch.Tensor | None,
        char_ids: torch.Tensor | None,
        phrase_features: torch.Tensor | None,
        anchor_features: torch.Tensor | None,
        anchor_confidence: torch.Tensor | None,
        gazetteer_features: torch.Tensor | None,
        gazetteer_confidence: torch.Tensor | None,
        country_features: torch.Tensor | None,
        country_confidence: torch.Tensor | None,
        street_type_features: torch.Tensor | None,
        street_type_confidence: torch.Tensor | None,
        locality_surface_features: torch.Tensor | None,
        locality_surface_confidence: torch.Tensor | None,
    ) -> torch.Tensor:

        if self.use_char_embed:
            if char_ids is None:
                raise ValueError("use_char_embed=True requires char_ids (B, S, W)")
            bsz, seq = int(char_ids.shape[0]), int(char_ids.shape[1])
            device = char_ids.device
            tok_embed = self.char_cnn(char_ids)  # type: ignore[misc]
        else:
            if input_ids is None:
                raise ValueError("input_ids required when use_char_embed=False")
            bsz, seq = input_ids.shape
            device = input_ids.device
            tok_embed = self.token_embeddings(input_ids)
        if seq > self.max_position_embeddings:
            raise ValueError(f"sequence length {seq} exceeds max_position_embeddings {self.max_position_embeddings}")
        pos = torch.arange(seq, device=device).unsqueeze(0).expand(bsz, seq)
        h = tok_embed + self.position_embeddings(pos)

        if self.phrase_input_projection is not None:
            if phrase_features is None:
                phrase_features = torch.zeros(
                    bsz,
                    seq,
                    self.phrase_feature_dim,
                    dtype=h.dtype,
                    device=h.device,
                )
            elif phrase_features.shape != (bsz, seq, self.phrase_feature_dim):
                raise ValueError(
                    f"phrase_features shape {tuple(phrase_features.shape)} != ({bsz}, {seq}, {self.phrase_feature_dim})"
                )
            else:
                phrase_features = phrase_features.to(h.dtype)
            h = self.phrase_input_projection(torch.cat([h, phrase_features], dim=-1))
        elif phrase_features is not None:
            raise ValueError(
                "phrase_features supplied but use_phrase_priors=False — rebuild the "
                "encoder with use_phrase_priors=True or drop the features argument"
            )

        return self._inject_channels(
            h,
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

    def _inject_channels(
        self,
        h: torch.Tensor,
        *,
        anchor_features: torch.Tensor | None,
        anchor_confidence: torch.Tensor | None,
        gazetteer_features: torch.Tensor | None,
        gazetteer_confidence: torch.Tensor | None,
        country_features: torch.Tensor | None,
        country_confidence: torch.Tensor | None,
        street_type_features: torch.Tensor | None,
        street_type_confidence: torch.Tensor | None,
        locality_surface_features: torch.Tensor | None,
        locality_surface_confidence: torch.Tensor | None,
    ) -> torch.Tensor:
        bsz, seq = h.shape[0], h.shape[1]

        h, anchor_vec = _inject_soft_feed(
            h,
            name="anchor",
            flag="use_postcode_anchor",
            projection=self.anchor_projection,
            cue=self.anchor_token_embedding,
            features=anchor_features,
            confidence=anchor_confidence,
            feature_dim=self.anchor_feature_dim,
        )
        if anchor_vec is not None:
            if anchor_confidence is None:
                anchor_confidence = torch.zeros(bsz, seq, dtype=h.dtype, device=h.device)
            if self.inject_first_token:
                conf = anchor_confidence.to(h.dtype)
                max_conf, max_idx = conf.max(dim=1)
                idx = max_idx.view(bsz, 1, 1).expand(bsz, 1, h.shape[-1])
                pooled_vec = anchor_vec.gather(1, idx).squeeze(1)
                pos0_add = (max_conf.unsqueeze(-1) * pooled_vec).unsqueeze(1)

                pos_indicator = (torch.arange(seq, device=h.device) == 0).to(h.dtype).view(1, seq, 1)
                h = h + pos0_add * pos_indicator

        h, _ = _inject_soft_feed(
            h,
            name="gazetteer",
            flag="use_gazetteer_anchor",
            projection=self.gazetteer_projection,
            cue=self.gazetteer_token_embedding,
            features=gazetteer_features,
            confidence=gazetteer_confidence,
            feature_dim=self.gazetteer_feature_dim,
        )

        h, _ = _inject_soft_feed(
            h,
            name="country",
            flag="use_country_anchor",
            projection=self.country_projection,
            cue=self.country_token_embedding,
            features=country_features,
            confidence=country_confidence,
            feature_dim=self.country_feature_dim,
            scale=self.country_feature_scale,
        )

        h, _ = _inject_soft_feed(
            h,
            name="street_type",
            flag="use_street_type_anchor",
            projection=self.street_type_projection,
            cue=self.street_type_token_embedding,
            features=street_type_features,
            confidence=street_type_confidence,
            feature_dim=self.street_type_feature_dim,
        )

        h, _ = _inject_soft_feed(
            h,
            name="locality_surface",
            flag="use_locality_surface_anchor",
            projection=self.locality_surface_projection,
            cue=self.locality_surface_token_embedding,
            features=locality_surface_features,
            confidence=locality_surface_confidence,
            feature_dim=self.locality_surface_feature_dim,
        )

        embedded: torch.Tensor = self.input_dropout(self.input_ln(h))
        return embedded
