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
from .crf import LinearChainCRF
from .labels import ID_TO_LABEL, LABEL_TO_ID, ACTIVE_BIO_LABELS


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

    __slots__ = ("loss", "logits")

    def __init__(self, logits: torch.Tensor, loss: torch.Tensor | None) -> None:
        self.logits = logits
        self.loss = loss


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
    ) -> None:
        super().__init__()
        self.pad_token_id = pad_token_id
        self.max_position_embeddings = max_position_embeddings
        self.num_labels = num_labels
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

        self.token_embeddings = nn.Embedding(
            vocab_size, hidden_size, padding_idx=pad_token_id
        )
        self.position_embeddings = nn.Embedding(max_position_embeddings, hidden_size)
        self.input_dropout = nn.Dropout(hidden_dropout_prob)
        self.input_ln = nn.LayerNorm(hidden_size)

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

    def forward(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor | None = None,
        labels: torch.Tensor | None = None,
    ) -> "_CoarseEncoderOutput":
        bsz, seq = input_ids.shape
        if seq > self.max_position_embeddings:
            raise ValueError(
                f"sequence length {seq} exceeds max_position_embeddings "
                f"{self.max_position_embeddings}"
            )
        pos = torch.arange(seq, device=input_ids.device).unsqueeze(0).expand(bsz, seq)
        h = self.token_embeddings(input_ids) + self.position_embeddings(pos)
        h = self.input_dropout(self.input_ln(h))

        # nn.MultiheadAttention key_padding_mask: True = mask (ignore), False = keep.
        kpm: torch.Tensor | None = None
        if attention_mask is not None:
            kpm = attention_mask == 0  # 0 = pad → True (mask)

        for block in self.blocks:
            h = block(h, key_padding_mask=kpm)

        h = self.final_ln(h)
        logits = self.classifier(h)

        loss: torch.Tensor | None = None
        if labels is not None:
            ce_loss = nn.functional.cross_entropy(
                logits.view(-1, self.num_labels),
                labels.view(-1),
                ignore_index=-100,
                label_smoothing=self.label_smoothing,
            )
            if self.crf is not None and attention_mask is not None:
                # CRF NLL needs a (B, S) float mask. attention_mask is long-typed; cast.
                # Replace IGNORE_INDEX positions in labels with 0 so gather doesn't OOB
                # — those positions are zeroed by the mask anyway.
                crf_mask = attention_mask.to(logits.dtype)
                crf_loss = self.crf(emissions=logits, tags=labels.clamp(min=0), mask=crf_mask)
                # Dual loss: CE (per-token) keeps emissions discriminative; CRF NLL (per-
                # sequence) is the structural regularizer. CRF magnitude is ~10–100x CE so
                # equal weighting destabilizes — first-attempt training collapsed at
                # weight=1.0. crf_loss_weight defaults to 0.1; tune via the kwarg.
                loss = ce_loss + self.crf_loss_weight * crf_loss
            else:
                loss = ce_loss
        return _CoarseEncoderOutput(logits=logits, loss=loss)

    @torch.no_grad()
    def predict(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
    ) -> list[list[int]]:
        """Best-path tag IDs per row. Returns variable-length lists (mask-trimmed).

        Uses CRF Viterbi when the layer is present; falls back to per-token argmax
        otherwise (the v0.2.0 behavior — kept for ablation / pre-CRF checkpoints).
        """
        out = self.forward(input_ids=input_ids, attention_mask=attention_mask)
        if self.crf is not None:
            return self.crf.viterbi_decode(out.logits, attention_mask.to(out.logits.dtype))
        # Argmax fallback. Trim per row to mask length.
        argmax_ids = out.logits.argmax(dim=-1)
        results: list[list[int]] = []
        for b in range(argmax_ids.size(0)):
            length = int(attention_mask[b].sum().item())
            results.append(argmax_ids[b, :length].tolist())
        return results

    # ---- HuggingFace-compatible save/load helpers ----

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
            "id2label": dict(ID_TO_LABEL),
            "label2id": dict(LABEL_TO_ID),
        }
        (output_dir / "config.json").write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")

    @classmethod
    def from_pretrained(cls, model_dir: Path | str) -> "MailwomanCoarseEncoder":
        model_dir = Path(model_dir)
        cfg = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
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
    )


def model_param_count(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters())
