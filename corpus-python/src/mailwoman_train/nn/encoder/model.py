"""Hand-rolled token-classification encoder for the Stage 1 coarse model.

Why not ``transformers.BertForTokenClassification``? gfx1103 (Radeon 780M) — the lab's
training GPU — crashes through both flash- and mem-efficient-SDPA on bf16, and
``nn.TransformerEncoderLayer``'s fused path hangs at batch ≥128 fp32. The validated path
on this hardware (per ``project-lab-gpu-780m`` operator memory) is:

- Force math SDPA: ``enable_math_sdp(True)``, the other two off.
- Hand-roll the encoder layer: ``nn.MultiheadAttention`` + ``nn.LayerNorm`` + linear FFN.
  *Do not* use ``nn.TransformerEncoderLayer``.
- bf16 dtype, batch ≤192. ~175 samples/sec sustained on this hardware.

This module ships a thin, ONNX-friendly ``MailwomanCoarseEncoder`` that:

- Uses ``nn.MultiheadAttention(batch_first=True)`` — natural for token-classification.
- Pre-norm transformer block layout (LN → attention → residual → LN → FFN → residual).
  Pre-norm is more stable from scratch with no warmup of LR-on-LN, which matches the
  Phase 2 plan's "from-scratch initialization" choice.
- ``key_padding_mask`` from the attention mask so padding doesn't pollute attention.
- Linear classifier head over ``num_labels``.

Compatibility with the older ``BertForTokenClassification.from_pretrained`` checkpoints is
intentionally NOT preserved — the smoke artifacts from the previous (CPU) iteration are
replaced wholesale.
"""

from __future__ import annotations

from pathlib import Path

import torch
from torch import nn

from ...features.phrase_priors import PHRASE_FEATURE_DIM
from ...labels import ID_TO_LABEL, NUM_LOCALES
from .. import serialization
from ..blocks import EncoderBlock
from ..char_cnn import CharCNNEmbedding
from .channels import CoarseEncoderChannels
from .decode import CoarseEncoderDecode
from .heads import CoarseEncoderHeads
from .losses import CoarseEncoderLosses
from .output import CoarseEncoderOutput
from .soft_feed import soft_feed_channel

#: The pre-split spellings. `_CoarseEncoderOutput` is constructed by name in `forward` and
#: `_soft_feed_channel` in `__init__`; keeping the aliases means the method bodies that moved
#: between files did not have to change a character, which is what lets the parity reference
#: pin the move.
_CoarseEncoderOutput = CoarseEncoderOutput
_soft_feed_channel = soft_feed_channel


class MailwomanCoarseEncoder(CoarseEncoderHeads, CoarseEncoderChannels, CoarseEncoderLosses, CoarseEncoderDecode):
    """Minimal transformer for Stage 1 coarse BIO token classification.

    Inputs:
        input_ids: ``(batch, seq)`` long tensor of SentencePiece token IDs.
        attention_mask: ``(batch, seq)`` long tensor of 1 (real token) / 0 (pad).

    Output:
        Always returns a dict with ``logits`` ``(batch, seq, num_labels)``. When ``labels``
        is provided, also returns ``loss`` (cross-entropy with ignore_index = -100).

    The four bases carry method bodies, never state: each derives from `CoarseEncoderState`,
    which declares what this constructor establishes and assigns nothing. So the only `__init__`
    in the chain is `nn.Module`'s, and every parameter, buffer and submodule is registered here
    in the order the lines below run.
    """

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
        # #727 stage-2 phase 1 — the semi-Markov span scorer (see span_scorer.py).
        use_span_scorer: bool = False,
        span_loss_weight: float = 0.0,
        span_dim: int = 128,
        max_span: int = 8,
        use_char_embed: bool = False,
        char_vocab_size: int = 0,
        char_embed_dim: int = 64,
        char_kernel_sizes: tuple[int, ...] = (3, 4, 5),
        # v8 CJK Phase 2: THIS model's label map (index -> BIO label). None = the module-global
        # STAGE3 map (every pre-Phase-2 checkpoint). The JP 47-label head passes its own; save()
        # persists it and from_pretrained() restores it, so a checkpoint always knows its labels.
        id_to_label: dict[int, str] | None = None,
    ) -> None:
        super().__init__()
        self.pad_token_id = pad_token_id
        self.max_position_embeddings = max_position_embeddings
        self.hidden_size = hidden_size
        self.num_labels = num_labels
        if id_to_label is not None:
            self.id_to_label: dict[int, str] = dict(id_to_label)
            if len(self.id_to_label) != num_labels:
                raise ValueError(f"id_to_label carries {len(self.id_to_label)} labels but num_labels={num_labels}")
        else:
            # Default = the module-global STAGE3 map, truncated to num_labels (the historical
            # behavior — probe/test models with small heads index a prefix of it). A head WIDER
            # than the global map has no honest default and must pass its own.
            if num_labels > len(ID_TO_LABEL):
                raise ValueError(f"num_labels={num_labels} exceeds the default label map — pass id_to_label")
            self.id_to_label = {i: ID_TO_LABEL[i] for i in range(num_labels)}
        # PR3 self-conditioning: an auxiliary locale head over the pooled sequence + a FiLM
        # modulation of the per-token reps by the inferred locale. See forward() for the data
        # flow and the design doc (2026-06-04-pr3-self-conditioned-retrain.md) for the why.
        self.use_locale_conditioning = use_locale_conditioning
        self.num_locales = int(num_locales)
        self.locale_loss_weight = float(locale_loss_weight)
        # v0.5.0 thread C: phrase-prior input-layer features (from Stage 2.7 phrase grouper,
        # Thread E). When ``use_phrase_priors`` is on, the encoder takes an additional
        # ``(B, S, phrase_feature_dim)`` tensor at forward time, concatenates it onto the
        # token+position embedding, and projects back to ``hidden_size``. The projection is
        # the minimum addition needed to thread the structural prior through without bumping
        # the encoder body's hidden dim — keeps the v0.5.0 baseline fair vs v0.3.0/v0.4.0
        # so the phrase-prior contribution can be ablated cleanly.
        self.use_phrase_priors = use_phrase_priors
        self.phrase_feature_dim = int(phrase_feature_dim) if use_phrase_priors else 0
        # A disabled channel records width 0 and constructs nothing, so its absence is not a
        # zero-width projection but no projection at all.
        self.use_postcode_anchor = use_postcode_anchor
        self.anchor_feature_dim = int(anchor_feature_dim) if use_postcode_anchor else 0
        # Dual-injection (#327): also place the pooled anchor at position 0. Only meaningful with the
        # anchor on; harmlessly ignored otherwise.
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
        # v0.3.0 additions: CRF decoder for structural validity + learned tag dynamics,
        # label smoothing on the per-token CE leg for calibration. Both conditionable for
        # ablation studies via the kwargs above.
        self.use_crf = use_crf
        self.label_smoothing = label_smoothing
        # CRF NLL is per-sequence (not per-token like CE), and unbounded — at random init
        # it can be ~seq_len*log(num_tags) ≈ 128*3 = 380 vs CE's ~log(num_tags) ≈ 3 per token.
        # Equal-weight summing lets CRF gradients drown out CE. 0.1 keeps CRF as a structural
        # regularizer on the emissions without overwhelming the token-level discriminative
        # signal. First-attempt training (weight=1.0) plateaued + then regressed val_macro_f1
        # from 0.26 → 0.17 by step 750.
        self.crf_loss_weight = crf_loss_weight
        # v0.4.0: CRF NLL normalization mode. "per_sequence" preserves v0.3.0 behavior;
        # "per_token" sums NLL / total real tokens for a magnitude comparable to per-token
        # CE — eliminates the crf_loss_weight hand-tuning search v0.3.0 went through.
        if crf_normalization not in ("per_sequence", "per_token"):
            raise ValueError(f"crf_normalization must be 'per_sequence' or 'per_token', got {crf_normalization!r}")
        self.crf_normalization = crf_normalization
        # v0.6.2 diagnostic flag: force the CRF forward (NLL + transition-table forward pass)
        # to compute in fp32 even when the surrounding autocast region is bf16. The 2026-05-28
        # postmortem's hypothesis for v0.6.0's twin NaN failures was numerical instability of
        # the 33×33 transition matrix with masked `-inf` entries under bf16. Wrapping just the
        # CRF call in `torch.autocast(enabled=False)` keeps the rest of the model in bf16 for
        # throughput while isolating the suspect math. Default False to keep all existing
        # configs bit-identical to their prior runs.
        self.crf_fp32 = crf_fp32
        # v0.4.0: per-class CE weights as a buffer. Registered as a buffer so it follows
        # the model to GPU + serializes with state_dict. None disables (uniform weights).
        if class_weights is not None:
            if class_weights.shape != (num_labels,):
                raise ValueError(f"class_weights shape {tuple(class_weights.shape)} != expected ({num_labels},)")
            self.register_buffer("class_weights", class_weights.clone().detach().float())
        else:
            self.class_weights = None

        self.token_embeddings = nn.Embedding(vocab_size, hidden_size, padding_idx=pad_token_id)
        self.position_embeddings = nn.Embedding(max_position_embeddings, hidden_size)
        self.input_dropout = nn.Dropout(hidden_dropout_prob)
        self.input_ln = nn.LayerNorm(hidden_size)
        # CharCNN front-end (the #825 tokenizer-fragmentation fix). When on, the per-token embedding is
        # COMPOSED from the token's characters (see CharCNNEmbedding) instead of a SentencePiece piece-ID
        # lookup, so a whole word ("Čistá") is one token and diacritics never fragment the span. The
        # SentencePiece token_embeddings table stays built (unused in char mode) so the pretrain / MLM /
        # save code paths keep working unchanged; the ship-slim path drops it once the arch is chosen.
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
        # Linear projection ``(hidden + phrase_feature_dim) → hidden`` so the body's
        # transformer stack keeps its declared ``hidden_size``. xavier_uniform_ init via
        # ``_init_weights``; bias init zero. None when ``use_phrase_priors`` is off — the
        # forward path skips the projection entirely in that case (keeps v0.4.0 numerics
        # bit-identical for back-compat ablations).
        self.phrase_input_projection: nn.Linear | None
        if self.use_phrase_priors:
            self.phrase_input_projection = nn.Linear(hidden_size + self.phrase_feature_dim, hidden_size, bias=True)
        else:
            self.phrase_input_projection = None

        # The five soft-feed channels: a projection (feature_dim→hidden) plus a learned cue vector
        # each, or None when the channel is off.
        #
        # Do not reorder these. `_init_weights` walks `self.parameters()`, which yields them in
        # registration order and draws from the global RNG for each, so swapping two channels
        # changes the initial weights of both and of everything registered after them. A loaded
        # checkpoint is unaffected (load_state_dict overwrites), but a from-scratch run started
        # after a reorder no longer reproduces one started before it.
        self.anchor_projection, self.anchor_token_embedding = _soft_feed_channel(
            self.use_postcode_anchor, self.anchor_feature_dim, hidden_size
        )
        self.gazetteer_projection, self.gazetteer_token_embedding = _soft_feed_channel(
            self.use_gazetteer_anchor, self.gazetteer_feature_dim, hidden_size
        )
        self.country_projection, self.country_token_embedding = _soft_feed_channel(
            self.use_country_anchor, self.country_feature_dim, hidden_size
        )
        if self.use_country_anchor:
            # #1104 homograph-guard softener: a per-dim scale applied to country_features BEFORE the
            # projection. Dim 0 (country_surface) stays 1.0; dim 1 (country_ambiguous) scales by
            # country_ambiguous_scale (1.0 = v263 hard guard). A registered buffer so it EXPORTS as a
            # constant into the ONNX graph — inference feeds the raw feature, the graph does the scaling.
            scale = torch.ones(self.country_feature_dim)
            if self.country_feature_dim >= 2:
                scale[1] = self.country_ambiguous_scale
            self.register_buffer("country_feature_scale", scale, persistent=False)
        else:
            self.country_feature_scale = None
        self.street_type_projection, self.street_type_token_embedding = _soft_feed_channel(
            self.use_street_type_anchor, self.street_type_feature_dim, hidden_size
        )
        self.locality_surface_projection, self.locality_surface_token_embedding = _soft_feed_channel(
            self.use_locality_surface_anchor, self.locality_surface_feature_dim, hidden_size
        )

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

        self._build_heads(
            hidden_size=hidden_size,
            num_labels=num_labels,
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
        """Run the transformer body, condition on locale, emit logits, and compute the losses."""
        # nn.MultiheadAttention key_padding_mask: True = mask (ignore), False = keep.
        kpm: torch.Tensor | None = None
        if attention_mask is not None:
            kpm = attention_mask == 0  # 0 = pad → True (mask)

        for block in self.blocks:
            h = block(h, key_padding_mask=kpm)

        h = self.final_ln(h)

        # PR3 self-conditioning: infer a locale posterior from the WHOLE sequence, then let it
        # reshape the per-token reps before the BIO head. This is the "globally, before per-token
        # labels" step the design calls for — and the reason it earns its keep is the probe: the
        # postcode alone settles the country <50% of the time, so the model has to read the city
        # and street to know where it is, then condition on that. Runs at inference too (predict()
        # routes through here), so the conditioning shapes real emissions, not just the loss.
        locale_logits: torch.Tensor | None = None
        if self.use_locale_conditioning and self.locale_head is not None and self.locale_film is not None:
            # Mean-pool over real (non-pad) tokens. fp32 reduction on principle — the v0.6.0 CRF
            # NaN was a bf16-reduction failure, and we keep every new reduction in fp32.
            if attention_mask is not None:
                m = attention_mask.to(torch.float32).unsqueeze(-1)  # (B, S, 1)
                pooled = (h.float() * m).sum(dim=1) / m.sum(dim=1).clamp(min=1.0)  # (B, hidden)
            else:
                pooled = h.float().mean(dim=1)
            pooled = pooled.to(h.dtype)
            locale_logits = self.locale_head(pooled)  # (B, num_locales)
            # FiLM modulation: scale by (1 + gamma) and shift by beta, both predicted from the
            # pooled locale rep. gamma/beta start at 0 (zero-init film) so this begins as identity.
            # Split via two slices rather than ``.chunk(2)``: chunk exports to an opset-18
            # ``Split(num_outputs=2)`` node that onnxruntime-node (and the WASM/WebGPU web runtime)
            # reject as "Unrecognized attribute: num_outputs"; explicit slicing emits plain Slice
            # ops every runtime accepts. Mathematically identical — same trained weights.
            film = self.locale_film(pooled)
            gamma = film[..., : self.hidden_size]  # (B, hidden)
            beta = film[..., self.hidden_size :]  # (B, hidden)
            h = (1.0 + gamma).unsqueeze(1) * h + beta.unsqueeze(1)

        logits = self.classifier(h)

        affix_logits: torch.Tensor | None = None
        if self.use_affix_head:
            gaz = gazetteer_features
            if gaz is None:
                gaz = torch.zeros(bsz, seq, self.gazetteer_feature_dim or 5, dtype=h.dtype, device=h.device)
            affix_logits = self.affix_head(torch.cat([h, gaz.to(h.dtype)], dim=-1))
            # Merge: the head OWNS the affix columns (classes 1..4 -> the 4 affix label ids).
            logits = logits.clone()
            logits[:, :, self.affix_label_ids] = affix_logits[:, :, 1:]

        if self.use_deploc_head:
            # The separate dep-loc head OWNS the B/I-dependent_locality columns (classes 1..2), same
            # merge-in-forward contract as the affix head so the exported inference graph carries it.
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
        """Masked-language-model forward for self-supervised PRE-training (see pretrain.py).

        Mirrors ``forward``'s encoder body, then projects hidden states through the TIED token-
        embedding matrix (no new parameters -> the pretrain checkpoint's ``state_dict`` is identical
        to a supervised model's, so it loads via ``from_pretrained`` for fine-tuning). The classifier
        / CRF heads are untouched here — they stay at init through pretraining and are trained in the
        later supervised fine-tune. Phrase priors are intentionally not threaded (pretraining runs on
        raw text only).
        """
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
        # Tied head: (B, S, hidden) @ (hidden, vocab) -> (B, S, vocab).
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
