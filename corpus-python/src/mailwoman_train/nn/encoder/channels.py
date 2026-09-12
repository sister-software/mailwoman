"""Turning ids into token representations, and adding each evidence channel to them.

Every channel is additive and confidence-scaled, so an encoder built with a channel on and handed
no features for it returns exactly what one built without it returns. That identity is what lets a
channel ship default-off and a checkpoint trained before it stay comparable.
"""

from __future__ import annotations

import torch

from .soft_feed import inject_soft_feed
from .state import CoarseEncoderState

#: The pre-split spelling. `_inject_channels` calls the helper by name, so keeping the alias means
#: the method body moved between files without changing a character.
_inject_soft_feed = inject_soft_feed


class CoarseEncoderChannels(CoarseEncoderState):
    """The embedding and evidence-channel half of `MailwomanCoarseEncoder`."""

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
        """Token representations with every enabled soft-feed channel added.

        Each channel is additive and confidence-scaled, so this returns exactly what an encoder
        built without any of them would return when none is enabled or none is supplied.
        """
        # Token embedding source: char-composed (CharCNN over per-token char IDs, shape (B, S, W)) or the
        # SentencePiece piece-ID lookup (input_ids, shape (B, S)). Everything after `h` is identical.
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
        # v0.5.0 thread C: optional phrase-prior conditioning. ``phrase_features`` is the
        # per-token BIE+kind one-hot from Stage 2.7. When the encoder was built with
        # ``use_phrase_priors=True`` and features are supplied, concat them onto the embed
        # and project back to hidden_size; absent features default to zeros (silently — a
        # caller that opted into priors but didn't supply them gets the equivalent of "no
        # phrase covers any token," which is a degraded but well-defined inference path).
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
            # Caller passed features but the encoder wasn't built to use them. Surface this
            # rather than silently ignoring — wiring drift is exactly the bug class the
            # smoke test is designed to catch.
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
        """Add each enabled soft-feed channel to the token representations.

        The channels are independent and additive, so their order here does not change the result.
        That is unlike their CONSTRUCTION order, which decides what `_init_weights` draws for each.
        """
        bsz, seq = h.shape[0], h.shape[1]

        # The anchor is the one channel with a second injection: see the pooled position-0 add below.
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
                # Dual-injection (#327, v0.9.4): ALSO inject the pooled anchor at position 0 — an
                # order-INDEPENDENT global cue the locality can attend back to regardless of where the
                # postcode sits. Pool each sequence by its max-confidence token (the postcode span) via
                # gather (ONNX-clean), scale by that confidence so an all-zero (no-anchor) sequence stays
                # the EXACT c=0 identity, and add it only at position 0 (functional cat, no in-place).
                conf = anchor_confidence.to(h.dtype)
                max_conf, max_idx = conf.max(dim=1)  # (B,), (B,)
                idx = max_idx.view(bsz, 1, 1).expand(bsz, 1, h.shape[-1])  # (B, 1, hidden)
                pooled_vec = anchor_vec.gather(1, idx).squeeze(1)  # (B, hidden) — the postcode token's anchor_vec
                pos0_add = (max_conf.unsqueeze(-1) * pooled_vec).unsqueeze(1)  # (B, 1, hidden)
                # Place it ONLY at position 0 via a position-0 indicator broadcast — avoids a dynamic
                # `seq-1` cat that trips the ONNX opset version-converter. (1, S, 1) × (B, 1, hidden).
                pos_indicator = (torch.arange(seq, device=h.device) == 0).to(h.dtype).view(1, seq, 1)
                h = h + pos0_add * pos_indicator

        # Gazetteer-anchor injection (#464). Confidence is 1.0 where any lexicon bit fires, 0
        # elsewhere. Span-local by construction; no first-token pooling, because a lexicon clue is a
        # positional fact about the token it sits on, where a postcode identifies the whole row.
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

        # Country-lexicon injection (#1104). Per-token additive: t_i = c_i · (W_c·features + v_CTRY),
        # added to the input embedding. Confidence is 1.0 where a country surface fires, 0 elsewhere —
        # the no-clue identity (same continuum as the other channels). Independent of the gazetteer's
        # near-postcode suppression: a trailing "…12345 USA" keeps its country clue.
        # The #1104 homograph-guard softener rides in as `scale`: a per-dim buffer
        # [1.0, ambiguous_scale] applied before the projection. No-op at scale 1.0 (v263); bakes
        # into the ONNX graph at export, so inference feeds the raw feature.
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

        # Street-type injection (P-A / Option A). Per-token additive: s_i = c_i · (W_s·features + v_STREET).
        # Confidence is 1.0 where a street-type surface fires, 0 elsewhere — the no-clue identity. Span-local
        # positional fact; no first-token pooling. Gives the encoder the street-type evidence the P-A
        # diagnostic showed it never had, so a street name can be distinguished from a locality name.
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

        # Locality-surface injection (v3.16.0 evidence bundle). Per-token additive: l_i = c_i ·
        # (W_l·features + v_LOC). Same no-clue-identity continuum as every other channel.
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
