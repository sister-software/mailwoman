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

import json
import math
from dataclasses import asdict
from pathlib import Path
from typing import Any

import torch
from torch import nn

from .config import Config
from .crf import LinearChainCRF, TopKPath
from .labels import ID_TO_LABEL, LABEL_TO_ID, ACTIVE_BIO_LABELS, IGNORE_INDEX, NUM_LOCALES
from .phrase_priors import PHRASE_FEATURE_DIM


def force_math_sdpa() -> None:
    """Disable flash / mem-efficient SDPA; force math kernel.

    Required on gfx1103 (Radeon 780M). Safe no-op on other backends. Idempotent.
    """
    if hasattr(torch.backends, "cuda"):
        for attr, on in (
            ("enable_flash_sdp", False),
            ("enable_mem_efficient_sdp", False),
            ("enable_math_sdp", True),
        ):
            fn = getattr(torch.backends.cuda, attr, None)
            if callable(fn):
                fn(on)


class _CoarseEncoderOutput:
    """HuggingFace-style ``.loss`` / ``.logits`` accessor object.

    Kept as a thin attribute holder (not a dataclass) so the encoder forward stays close
    to the bert-style call signature the trainer and exporter expect.
    """

    __slots__ = ("loss", "logits", "locale_logits")

    def __init__(
        self,
        logits: torch.Tensor,
        loss: torch.Tensor | None,
        locale_logits: torch.Tensor | None = None,
    ) -> None:
        self.logits = logits
        self.loss = loss
        # PR3 self-conditioning: ``(batch, num_locales)`` locale posterior logits from the aux
        # head, or None when the encoder was built without ``use_locale_conditioning``.
        self.locale_logits = locale_logits


class EncoderBlock(nn.Module):
    """One pre-norm transformer block. Hand-rolled (see module docstring for the why)."""

    def __init__(
        self,
        hidden_size: int,
        num_heads: int,
        ff_intermediate: int,
        dropout: float,
    ) -> None:
        super().__init__()
        self.ln1 = nn.LayerNorm(hidden_size)
        self.attn = nn.MultiheadAttention(
            embed_dim=hidden_size,
            num_heads=num_heads,
            dropout=dropout,
            batch_first=True,
            bias=True,
        )
        self.ln2 = nn.LayerNorm(hidden_size)
        self.ff = nn.Sequential(
            nn.Linear(hidden_size, ff_intermediate),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(ff_intermediate, hidden_size),
        )
        self.dropout = nn.Dropout(dropout)

    def forward(
        self,
        x: torch.Tensor,
        key_padding_mask: torch.Tensor | None,
    ) -> torch.Tensor:
        # Pre-norm attention.
        h = self.ln1(x)
        attn_out, _ = self.attn(
            h, h, h,
            key_padding_mask=key_padding_mask,
            need_weights=False,
        )
        x = x + self.dropout(attn_out)
        # Pre-norm FFN.
        h = self.ln2(x)
        x = x + self.dropout(self.ff(h))
        return x


class MailwomanCoarseEncoder(nn.Module):
    """Minimal transformer for Stage 1 coarse BIO token classification.

    Inputs:
        input_ids: ``(batch, seq)`` long tensor of SentencePiece token IDs.
        attention_mask: ``(batch, seq)`` long tensor of 1 (real token) / 0 (pad).

    Output:
        Always returns a dict with ``logits`` ``(batch, seq, num_labels)``. When ``labels``
        is provided, also returns ``loss`` (cross-entropy with ignore_index = -100).
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
    ) -> None:
        super().__init__()
        self.pad_token_id = pad_token_id
        self.max_position_embeddings = max_position_embeddings
        self.hidden_size = hidden_size
        self.num_labels = num_labels
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
        # v0.3.0 additions: CRF decoder for structural validity + learned tag dynamics,
        # label smoothing on the per-token CE leg for calibration. Both gate-able for
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
            raise ValueError(
                f"crf_normalization must be 'per_sequence' or 'per_token', got {crf_normalization!r}"
            )
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
                raise ValueError(
                    f"class_weights shape {tuple(class_weights.shape)} != expected ({num_labels},)"
                )
            self.register_buffer("class_weights", class_weights.clone().detach().float())
        else:
            self.class_weights = None

        self.token_embeddings = nn.Embedding(
            vocab_size, hidden_size, padding_idx=pad_token_id
        )
        self.position_embeddings = nn.Embedding(max_position_embeddings, hidden_size)
        self.input_dropout = nn.Dropout(hidden_dropout_prob)
        self.input_ln = nn.LayerNorm(hidden_size)
        # Linear projection ``(hidden + phrase_feature_dim) → hidden`` so the body's
        # transformer stack keeps its declared ``hidden_size``. xavier_uniform_ init via
        # ``_init_weights``; bias init zero. None when ``use_phrase_priors`` is off — the
        # forward path skips the projection entirely in that case (keeps v0.4.0 numerics
        # bit-identical for back-compat ablations).
        self.phrase_input_projection: nn.Linear | None
        if self.use_phrase_priors:
            self.phrase_input_projection = nn.Linear(
                hidden_size + self.phrase_feature_dim, hidden_size, bias=True
            )
        else:
            self.phrase_input_projection = None

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

        # CRF decoder (Stage 2 / v0.3.0 onwards). Adds ~num_labels² + 2·num_labels learned
        # scalars (483 for 21 labels) — negligible vs the encoder's ~30M parameters.
        # Disabled via use_crf=False for ablation studies or backwards compat with
        # pre-v0.3.0 checkpoints.
        self.crf: LinearChainCRF | None = LinearChainCRF(num_labels, ID_TO_LABEL) if use_crf else None

        # PR3 self-conditioning modules. ``locale_head`` maps the pooled (mean over real tokens)
        # representation to the locale posterior — the aux supervised signal AND the exported
        # LocalePosterior. ``locale_film`` produces a (scale, shift) pair from the same pooled
        # vector that FiLM-modulates the per-token reps feeding the BIO head. ``locale_film`` is
        # zero-initialized in _init_weights so the model starts as the EXACT identity of an
        # unconditioned encoder (gamma=0, beta=0 → h unchanged) and only learns to modulate as the
        # aux gradient flows — this is the de-risking move against the CRF-style from-scratch
        # divergence (one new behaviour, introduced gently, not a cold-start architecture shock).
        self.locale_head: nn.Linear | None
        self.locale_film: nn.Linear | None
        if self.use_locale_conditioning:
            self.locale_head = nn.Linear(hidden_size, self.num_locales)
            self.locale_film = nn.Linear(hidden_size, 2 * hidden_size)
        else:
            self.locale_head = None
            self.locale_film = None

        self._init_weights()

    def _init_weights(self) -> None:
        """Xavier-style init for linears + small-normal embeddings + LN gamma=1.

        Critical: ``nn.LayerNorm.weight`` (``gamma``) MUST be initialized to 1.0, not 0.
        A previous version zeroed every 1D parameter, which collapsed every LN to a constant
        output (``gamma·normalized + beta`` = 0·anything + 0 = 0) and made the model
        predict the same class for every token regardless of input. Loss plateaued near
        the all-O baseline and macro-F1 sat at floor.
        """
        for p in self.parameters():
            if p.dim() > 1:
                nn.init.xavier_uniform_(p)
            elif p.dim() == 1 and p.requires_grad:
                nn.init.zeros_(p)
        # Reset every LayerNorm to default (gamma=1, beta=0). The blanket loop above
        # accidentally zeroed gamma; LN with gamma=0 emits 0 + beta for all inputs.
        for module in self.modules():
            if isinstance(module, nn.LayerNorm):
                nn.init.ones_(module.weight)
                if module.bias is not None:
                    nn.init.zeros_(module.bias)
        nn.init.normal_(self.token_embeddings.weight, mean=0.0, std=0.02)
        nn.init.normal_(self.position_embeddings.weight, mean=0.0, std=0.02)
        if self.token_embeddings.padding_idx is not None:
            with torch.no_grad():
                self.token_embeddings.weight[self.token_embeddings.padding_idx].zero_()
        # PR3: zero-init the FiLM projection so conditioning starts as a no-op (gamma=0, beta=0).
        # The blanket xavier loop above gave it real weights; reset them so the from-scratch model
        # begins identical to an unconditioned encoder and learns to modulate gradually.
        if self.locale_film is not None:
            nn.init.zeros_(self.locale_film.weight)
            nn.init.zeros_(self.locale_film.bias)

    def forward(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor | None = None,
        labels: torch.Tensor | None = None,
        phrase_features: torch.Tensor | None = None,
        locale_ids: torch.Tensor | None = None,
    ) -> "_CoarseEncoderOutput":
        bsz, seq = input_ids.shape
        if seq > self.max_position_embeddings:
            raise ValueError(
                f"sequence length {seq} exceeds max_position_embeddings "
                f"{self.max_position_embeddings}"
            )
        pos = torch.arange(seq, device=input_ids.device).unsqueeze(0).expand(bsz, seq)
        h = self.token_embeddings(input_ids) + self.position_embeddings(pos)
        # v0.5.0 thread C: optional phrase-prior conditioning. ``phrase_features`` is the
        # per-token BIE+kind one-hot from Stage 2.7. When the encoder was built with
        # ``use_phrase_priors=True`` and features are supplied, concat them onto the embed
        # and project back to hidden_size; absent features default to zeros (silently — a
        # caller that opted into priors but didn't supply them gets the equivalent of "no
        # phrase covers any token," which is a degraded but well-defined inference path).
        if self.phrase_input_projection is not None:
            if phrase_features is None:
                phrase_features = torch.zeros(
                    bsz, seq, self.phrase_feature_dim,
                    dtype=h.dtype, device=h.device,
                )
            elif phrase_features.shape != (bsz, seq, self.phrase_feature_dim):
                raise ValueError(
                    f"phrase_features shape {tuple(phrase_features.shape)} != "
                    f"({bsz}, {seq}, {self.phrase_feature_dim})"
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
        h = self.input_dropout(self.input_ln(h))

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

        loss: torch.Tensor | None = None
        if labels is not None:
            ce_kwargs: dict[str, Any] = {
                "ignore_index": -100,
                "label_smoothing": self.label_smoothing,
            }
            # v0.4.0: optional per-class CE weights to compensate for v0.3.0's coarse
            # regression under the 21-label space. See ModelConfig.class_weights docs.
            if isinstance(self.class_weights, torch.Tensor):
                ce_kwargs["weight"] = self.class_weights
            ce_loss = nn.functional.cross_entropy(
                logits.view(-1, self.num_labels),
                labels.view(-1),
                **ce_kwargs,
            )
            if self.crf is not None and attention_mask is not None and self.crf_loss_weight > 0:
                # CRF NLL needs a (B, S) float mask. attention_mask is long-typed; cast.
                # Replace IGNORE_INDEX positions in labels with 0 so gather doesn't OOB
                # — those positions are zeroed by the mask anyway.
                # v0.4.0: pass crf_normalization through — "per_token" mode produces a
                # loss comparable in magnitude to per-token CE, letting the two be
                # summed without crf_loss_weight tuning.
                crf_reduction = "per_token" if self.crf_normalization == "per_token" else "mean"
                if self.crf_fp32:
                    # v0.6.2 diagnostic path: disable autocast for the CRF forward and upcast
                    # emissions + mask to fp32. The transition-table forward pass operates on
                    # masked-`-inf` entries that lose precision under bf16's 7-bit mantissa,
                    # which the postmortem fingered as the likely v0.6.0 NaN cause. fp32 has
                    # 23-bit mantissa — enough headroom for `logsumexp` over -1e30 sentinels.
                    device_type = logits.device.type
                    with torch.autocast(device_type=device_type, enabled=False):
                        emissions_fp32 = logits.float()
                        crf_mask = attention_mask.to(emissions_fp32.dtype)
                        crf_loss = self.crf(
                            emissions=emissions_fp32,
                            tags=labels.clamp(min=0),
                            mask=crf_mask,
                            reduction=crf_reduction,
                        )
                else:
                    crf_mask = attention_mask.to(logits.dtype)
                    crf_loss = self.crf(
                        emissions=logits,
                        tags=labels.clamp(min=0),
                        mask=crf_mask,
                        reduction=crf_reduction,
                    )
                # Dual loss: CE (per-token) keeps emissions discriminative; CRF NLL is
                # the structural regularizer. Under per_sequence normalization (v0.3.0),
                # crf_loss_weight=0.05–0.1 is typical to balance magnitudes. Under
                # per_token (v0.4.0), crf_loss_weight can be 1.0 cleanly.
                # Cast crf_loss back to ce_loss's dtype before summing — the optimizer sees
                # one consistent loss tensor regardless of which path produced it.
                loss = ce_loss + self.crf_loss_weight * crf_loss.to(ce_loss.dtype)
            else:
                loss = ce_loss

        # PR3: auxiliary locale cross-entropy. Supervises the locale head against the row's
        # country so the pooled representation (and therefore the FiLM conditioning) actually
        # encodes "which country". fp32 CE over the small locale vocabulary. Rows whose country
        # is unmapped carry IGNORE_INDEX and are skipped; a batch with no mapped row contributes
        # nothing (guards the all-ignored 0/0 → NaN edge).
        if (
            self.use_locale_conditioning
            and locale_logits is not None
            and locale_ids is not None
            and self.locale_loss_weight > 0
            and bool((locale_ids != IGNORE_INDEX).any())
        ):
            locale_ce = nn.functional.cross_entropy(
                locale_logits.float(),
                locale_ids,
                ignore_index=IGNORE_INDEX,
            )
            locale_term = self.locale_loss_weight * locale_ce
            loss = locale_term if loss is None else loss + locale_term.to(loss.dtype)

        return _CoarseEncoderOutput(logits=logits, loss=loss, locale_logits=locale_logits)

    @torch.no_grad()
    def predict(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
        phrase_features: torch.Tensor | None = None,
    ) -> list[list[int]]:
        """Best-path tag IDs per row. Returns variable-length lists (mask-trimmed).

        Uses CRF Viterbi when the layer is present; falls back to per-token argmax
        otherwise (the v0.2.0 behavior — kept for ablation / pre-CRF checkpoints).
        """
        out = self.forward(
            input_ids=input_ids,
            attention_mask=attention_mask,
            phrase_features=phrase_features,
        )
        if self.crf is not None:
            return self.crf.viterbi_decode(out.logits, attention_mask.to(out.logits.dtype))
        # Argmax fallback. Trim per row to mask length.
        argmax_ids = out.logits.argmax(dim=-1)
        results: list[list[int]] = []
        for b in range(argmax_ids.size(0)):
            length = int(attention_mask[b].sum().item())
            results.append(argmax_ids[b, :length].tolist())
        return results

    @torch.no_grad()
    def predict_top_k(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
        k: int = 5,
        phrase_features: torch.Tensor | None = None,
    ) -> list[list[TopKPath]]:
        """Top-K tag sequences per row with calibrated log-prob scores.

        v0.5.0 thread C: this is what Stage 5 reconcile (Thread D) consumes. Each row
        gets up to ``k`` ``TopKPath`` items, sorted by score descending. Padding is
        trimmed from each path's ``sequence``. Only works when the encoder was built with
        ``use_crf=True`` — argmax-only encoders have no notion of path probability.
        """
        if self.crf is None:
            raise RuntimeError(
                "predict_top_k requires a CRF decoder; this encoder was built with "
                "use_crf=False. Either rebuild with use_crf=True or use predict()."
            )
        out = self.forward(
            input_ids=input_ids,
            attention_mask=attention_mask,
            phrase_features=phrase_features,
        )
        return self.crf.top_k_decode(out.logits, attention_mask.to(out.logits.dtype), k=k)

    # ---- HuggingFace-compatible save/load helpers ----

    def forward_mlm(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor | None = None,
        mlm_labels: torch.Tensor | None = None,
    ) -> "_CoarseEncoderOutput":
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
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        torch.save(self.state_dict(), output_dir / "pytorch_model.bin")
        cfg = {
            "model_type": "mailwoman-coarse-encoder",
            "vocab_size": int(self.token_embeddings.num_embeddings),
            "hidden_size": int(self.token_embeddings.embedding_dim),
            "num_hidden_layers": len(self.blocks),
            "num_attention_heads": self.blocks[0].attn.num_heads,
            "intermediate_size": int(self.blocks[0].ff[0].out_features),
            "max_position_embeddings": int(self.max_position_embeddings),
            "hidden_dropout_prob": float(self.input_dropout.p),
            "num_labels": int(self.num_labels),
            "pad_token_id": int(self.pad_token_id),
            "use_crf": bool(self.use_crf),
            "label_smoothing": float(self.label_smoothing),
            "crf_loss_weight": float(self.crf_loss_weight),
            "crf_normalization": str(self.crf_normalization),
            # v0.4.0: class_weights persisted as a label→weight dict for human
            # readability. None when uniform (no per-class biasing in effect).
            "class_weights": (
                {ID_TO_LABEL[i]: float(w) for i, w in enumerate(self.class_weights.tolist())}
                if isinstance(self.class_weights, torch.Tensor)
                else None
            ),
            # v0.5.0 thread C: phrase-prior conditioning. False on v0.4.0/v0.3.0 weights;
            # True on v0.5.0+. Loaders branch on this flag to materialize the
            # ``phrase_input_projection`` layer.
            "use_phrase_priors": bool(self.use_phrase_priors),
            "phrase_feature_dim": int(self.phrase_feature_dim),
            # PR3 self-conditioning. False/0 on pre-PR3 weights; loaders branch on the flag to
            # materialize locale_head / locale_film at the persisted num_locales width.
            "use_locale_conditioning": bool(self.use_locale_conditioning),
            "num_locales": int(self.num_locales),
            "locale_loss_weight": float(self.locale_loss_weight),
            "id2label": dict(ID_TO_LABEL),
            "label2id": dict(LABEL_TO_ID),
        }
        (output_dir / "config.json").write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")

    @classmethod
    def from_pretrained(cls, model_dir: Path | str) -> "MailwomanCoarseEncoder":
        model_dir = Path(model_dir)
        cfg = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
        # v0.4.0: reconstruct the class_weights tensor in label-index order.
        # Absent / None in config → uniform.
        cw_dict = cfg.get("class_weights")
        cw_tensor: torch.Tensor | None = None
        if cw_dict:
            cw_tensor = torch.tensor(
                [float(cw_dict.get(ID_TO_LABEL[i], 1.0)) for i in range(cfg["num_labels"])],
                dtype=torch.float32,
            )
        model = cls(
            vocab_size=cfg["vocab_size"],
            hidden_size=cfg["hidden_size"],
            num_hidden_layers=cfg["num_hidden_layers"],
            num_attention_heads=cfg["num_attention_heads"],
            intermediate_size=cfg["intermediate_size"],
            max_position_embeddings=cfg["max_position_embeddings"],
            hidden_dropout_prob=cfg["hidden_dropout_prob"],
            num_labels=cfg["num_labels"],
            pad_token_id=cfg["pad_token_id"],
            # v0.3.0+ fields. Default to v0.2.0 behavior (no CRF, no label smoothing)
            # for backwards-compat with pre-v0.3.0 checkpoints whose config.json predates
            # these keys.
            use_crf=cfg.get("use_crf", False),
            label_smoothing=cfg.get("label_smoothing", 0.0),
            crf_loss_weight=cfg.get("crf_loss_weight", 0.1),
            # v0.4.0+ fields. Default to v0.3.0 behavior (per_sequence, uniform CE).
            crf_normalization=cfg.get("crf_normalization", "per_sequence"),
            # v0.6.2 diagnostic. Inference-time loading ignores crf_fp32 because the
            # CRF call only fires when crf_loss_weight > 0 (training only).
            crf_fp32=cfg.get("crf_fp32", False),
            class_weights=cw_tensor,
            # v0.5.0+ fields. Default to v0.4.0 behavior (no phrase priors).
            use_phrase_priors=cfg.get("use_phrase_priors", False),
            phrase_feature_dim=cfg.get("phrase_feature_dim", PHRASE_FEATURE_DIM),
            # PR3 fields. Default off for back-compat with pre-PR3 checkpoints.
            use_locale_conditioning=cfg.get("use_locale_conditioning", False),
            num_locales=cfg.get("num_locales", NUM_LOCALES),
            locale_loss_weight=cfg.get("locale_loss_weight", 0.0),
        )
        # Use weights_only=True if available (torch 2.4+) to avoid pickle-arbitrary-code warning.
        try:
            sd = torch.load(model_dir / "pytorch_model.bin", weights_only=True)
        except TypeError:  # pragma: no cover — older torch
            sd = torch.load(model_dir / "pytorch_model.bin")
        model.load_state_dict(sd)
        return model


def build_model(cfg: Config, vocab_size: int, pad_token_id: int) -> MailwomanCoarseEncoder:
    """Instantiate ``MailwomanCoarseEncoder`` with the phase's geometry from ``cfg``."""
    # v0.4.0: derive the class_weights tensor from cfg.model.class_weights if set.
    # Labels not present in the dict default to weight 1.0 (no change vs uniform).
    cw_dict = getattr(cfg.model, "class_weights", None)
    cw_tensor: torch.Tensor | None = None
    if cw_dict:
        cw_tensor = torch.tensor(
            [float(cw_dict.get(label, 1.0)) for label in ACTIVE_BIO_LABELS],
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
        num_labels=len(ACTIVE_BIO_LABELS),
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
    )


def model_param_count(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters())
