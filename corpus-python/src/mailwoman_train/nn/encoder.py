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
from typing import Any

import torch
from torch import nn

from ..config import Config
from ..features.phrase_priors import PHRASE_FEATURE_DIM
from ..labels import ID_TO_LABEL, IGNORE_INDEX, NUM_LOCALES
from . import serialization
from .blocks import EncoderBlock
from .char_cnn import CharCNNEmbedding
from .crf import LinearChainCRF, TopKPath
from .span_scorer import SemiMarkovCRF, SpanScorer, gold_segments


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

    __slots__ = ("loss", "logits", "locale_logits", "span_scores")

    def __init__(
        self,
        logits: torch.Tensor,
        loss: torch.Tensor | None,
        locale_logits: torch.Tensor | None = None,
        span_scores: torch.Tensor | None = None,
    ) -> None:
        self.logits = logits
        self.loss = loss
        # #727 stage-2: (B, S, L, T) per-span type scores, or None without ``use_span_scorer``.
        self.span_scores = span_scores
        # PR3 self-conditioning: ``(batch, num_locales)`` locale posterior logits from the aux
        # head, or None when the encoder was built without ``use_locale_conditioning``.
        self.locale_logits = locale_logits


def _soft_feed_channel(
    enabled: bool,
    feature_dim: int,
    hidden_size: int,
) -> tuple[nn.Linear | None, nn.Parameter | None]:
    """One soft-feed channel's projection and learned cue vector, or a pair of Nones.

    Five channels (postcode anchor, gazetteer, country lexicon, street type, locality surface)
    are built the same way and differ only in their feature width. Expressing that five times is
    how the sixth gets built slightly differently.

    A disabled channel must construct nothing at all, not construct-and-discard. `_init_weights`
    re-initializes by walking `self.parameters()`, which yields parameters in registration order
    and draws from the global RNG for each, so an extra registered module shifts the initial
    weights of every parameter registered after it.
    """
    if not enabled:
        return None, None
    return nn.Linear(feature_dim, hidden_size, bias=True), nn.Parameter(torch.zeros(hidden_size))


def _inject_soft_feed(
    hidden: torch.Tensor,
    *,
    name: str,
    flag: str,
    projection: nn.Linear | None,
    cue: nn.Parameter | None,
    features: torch.Tensor | None,
    confidence: torch.Tensor | None,
    feature_dim: int,
    scale: torch.Tensor | None = None,
) -> tuple[torch.Tensor, torch.Tensor | None]:
    """Add one soft-feed channel to the token representations.

    Every channel is the same additive form: `h_i + c_i · (W · features_i + cue)`. The confidence
    scaling is what keeps a channel continuous rather than a switch — a token with no clue has
    c=0 and contributes exactly nothing, so an encoder given no features computes what an encoder
    built without the channel computes.

    Absent features on an ENABLED channel are zeros, which is the well-defined "no clue anywhere"
    inference path. Features supplied for a DISABLED channel raise: that combination means the
    caller built the wrong encoder, and silently dropping the evidence they passed would train or
    serve a model that ignores half its input.

    Returns the updated representations and the projected vector, which the postcode anchor needs
    for its second, pooled injection.
    """
    if projection is None or cue is None:
        if features is not None:
            raise ValueError(
                f"{name}_features supplied but {flag}=False — rebuild the "
                f"encoder with {flag}=True or drop the {name} arguments"
            )
        return hidden, None

    bsz, seq = hidden.shape[0], hidden.shape[1]
    if features is None or confidence is None:
        features = torch.zeros(bsz, seq, feature_dim, dtype=hidden.dtype, device=hidden.device)
        confidence = torch.zeros(bsz, seq, dtype=hidden.dtype, device=hidden.device)
    elif features.shape != (bsz, seq, feature_dim):
        raise ValueError(f"{name}_features shape {tuple(features.shape)} != ({bsz}, {seq}, {feature_dim})")

    projected = features.to(hidden.dtype)
    if scale is not None:
        projected = projected * scale.to(hidden.dtype)
    vector = projection(projected) + cue
    return hidden + confidence.to(hidden.dtype).unsqueeze(-1) * vector, vector


class MailwomanCoarseEncoder(nn.Module):
    """Minimal transformer for Stage 1 coarse BIO token classification.

    Inputs:
        input_ids: ``(batch, seq)`` long tensor of SentencePiece token IDs.
        attention_mask: ``(batch, seq)`` long tensor of 1 (real token) / 0 (pad).

    Output:
        Always returns a dict with ``logits`` ``(batch, seq, num_labels)``. When ``labels``
        is provided, also returns ``loss`` (cross-entropy with ignore_index = -100).
    """

    # register_buffer names typed so mypy reads them as tensors, not the Tensor | Module
    # union torch's setattr typing produces for undeclared module attributes.
    conventions_forbidden: torch.Tensor
    affix_target_lut: torch.Tensor
    bio_is_begin: torch.Tensor
    bio_is_inside: torch.Tensor
    country_feature_scale: torch.Tensor | None

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
        # Postcode-anchor conditioning channel (de-risk pilot, #239/#240; DeepSeek 2026-06-05).
        # A per-token additive injection at the postcode span: a_i = c_i · (W·anchor_features +
        # v_ANCHOR), added to the token+position embedding. anchor_features is a fixed-width
        # ``(B, S, anchor_feature_dim)`` vector — a uniform country posterior over the NUM_LOCALES
        # locale set (0 outside member countries) plus a 2-d centroid — and ``anchor_confidence`` is
        # the per-token ``(B, S)`` confidence scalar (0 outside any postcode span). Robustness is the
        # confidence CURRICULUM applied UPSTREAM (data loader perturbs the scalar by training step);
        # the model is perturbation-agnostic, so absent / zero-confidence anchors are just the c=0
        # tail of a continuum — no discrete [NO-ANCHOR] embedding, no regime switch. Position-local
        # by construction: this is the property self-conditioning's global FiLM lacked (it composes
        # with that FiLM cleanly — anchor at the INPUT, FiLM on the hidden states after the blocks).
        self.use_postcode_anchor = use_postcode_anchor
        self.anchor_feature_dim = int(anchor_feature_dim) if use_postcode_anchor else 0
        # Dual-injection (#327): also place the pooled anchor at position 0. Only meaningful with the
        # anchor on; harmlessly ignored otherwise.
        self.inject_first_token = bool(inject_first_token) and use_postcode_anchor
        # Gazetteer-anchor conditioning channel (#464; knowledge-ladder rung 3.2). Same additive
        # input-layer shape as the postcode anchor: g_i = c_i · (W_g·gazetteer_features + v_GAZ),
        # where gazetteer_features is the per-token multi-hot candidate-tag set (country/region/
        # po_box/cedex/homograph) painted from the RAW SURFACE by the codex lexicon — never from
        # labels, so train and inference share one computation. The clue INFORMS, the model decides
        # (model-first; the homograph bit explicitly marks "context is critical here"). c=0
        # tokens get g_i=0 — no regime switch, same continuum argument as the postcode anchor.
        self.use_gazetteer_anchor = use_gazetteer_anchor
        self.gazetteer_feature_dim = int(gazetteer_feature_dim) if use_gazetteer_anchor else 0
        # Country-lexicon conditioning channel (#1104). Same additive input-layer shape as the gazetteer
        # anchor: t_i = c_i · (W_c·country_features + v_CTRY), where country_features is the per-token
        # [country_surface, country_ambiguous] clue painted from the RAW SURFACE by the codex country
        # lexicon — never labels, so train and inference share one computation. Country is a CLOSED,
        # enumerable class (~250 surfaces) the learned grammar mislabels in the WOF-admin leading
        # long-form case; this de-entangles the country signal from the gazetteer's shared 5-hot slot
        # (its own projection + cue) and is NOT zeroed near a postcode. Clue informs, model decides.
        self.use_country_anchor = use_country_anchor
        self.country_feature_dim = int(country_feature_dim) if use_country_anchor else 0
        self.country_ambiguous_scale = float(country_ambiguous_scale)
        # Street-type conditioning channel (P-A / Option A, the retrieval-augmented-encoding probe). Same
        # additive input-layer shape as the country/gazetteer anchors: s_i = c_i · (W_s·street_features +
        # v_STREET), where street_features is a per-token multi-hot painted from the RAW SURFACE by the
        # codex street-type lexicon (rue/boulevard/street/straße/…) — never labels, so train and inference
        # share one computation. A SEPARATE channel (its own projection + cue), NOT a gazetteer slot, so
        # v385 loads bit-clean and no existing feature dim shifts. Positive-evidence-only. Clue informs,
        # model decides — the P-A hypothesis is that street↔locality LABELING errors are literal evidence
        # absence (P-C: open-vocab FR misses are mis-labeling, not mis-segmentation).
        self.use_street_type_anchor = use_street_type_anchor
        self.street_type_feature_dim = int(street_type_feature_dim) if use_street_type_anchor else 0
        # Locality-surface conditioning channel (v3.16.0 evidence-bundle probe — Option A's second
        # correlated channel). Same additive input-layer shape; features are the per-token
        # [locality, locality_homograph] clue painted from the RAW SURFACE by the locality-surface
        # lexicon (WOF US+FR locality/localadmin names, curated, homograph = place-name in ≥2
        # countries). The BUNDLE doctrine (P-A verdict): street-type and locality-membership must be
        # weighed against each other in context so neither becomes a decisive soft rule.
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

    def _build_heads(
        self,
        *,
        hidden_size: int,
        num_labels: int,
        use_conventions_loss_mask: bool,
        use_affix_head: bool,
        use_deploc_head: bool,
        use_span_boundary_head: bool,
        span_boundary_loss_weight: float,
        use_span_scorer: bool,
        span_loss_weight: float,
        span_dim: int,
        max_span: int,
        use_crf: bool,
    ) -> None:
        """The output heads.

        Do not reorder these, and keep the call where it sits in `__init__`. Registration order
        decides what `_init_weights` draws for each parameter, so a move changes the initial
        weights of every parameter registered after it and a from-scratch run stops reproducing
        earlier ones.
        """
        # Dedicated affix head (#492): MLP over [final hidden ; raw gazetteer 5-dim skip] ->
        # {O, B-street_prefix, I-street_prefix, B-street_suffix, I-street_suffix}. The gaz vector
        # skip-connects PAST the encoder so the head owns the clue->affix mapping (consult
        # 2026-06-10); independent dropout on the skip layers robustness locally. Its 4 affix
        # logits replace the main classifier's affix columns in forward (merge-in-forward).
        # Train-time conventions pairing (#478): per-locale forbidden-label mask applied to the
        # CE input only (returned logits untouched — inference behavior is the codex mask's job).
        self.use_conventions_loss_mask = bool(use_conventions_loss_mask)
        if self.use_conventions_loss_mask:
            from ..features.conventions import build_forbidden_mask
            from ..labels import LABEL_TO_ID

            self.register_buffer(
                "conventions_forbidden", build_forbidden_mask(LABEL_TO_ID, num_labels), persistent=False
            )

        self.use_affix_head = use_affix_head
        if use_affix_head:
            affix_in = hidden_size + (self.gazetteer_feature_dim or 5)
            self.affix_head = nn.Sequential(
                nn.Linear(affix_in, 256),
                nn.GELU(),
                nn.Dropout(0.1),
                nn.Linear(256, 5),
            )
            from ..labels import LABEL_TO_ID

            affix_ids = [
                LABEL_TO_ID["B-street_prefix"],
                LABEL_TO_ID["I-street_prefix"],
                LABEL_TO_ID["B-street_suffix"],
                LABEL_TO_ID["I-street_suffix"],
            ]
            self.register_buffer("affix_label_ids", torch.tensor(affix_ids, dtype=torch.long), persistent=False)
            # labels -> affix-class targets lookup: default 0 (O-or-other), affix ids -> 1..4.
            lut = torch.zeros(num_labels, dtype=torch.long)
            for k, lid in enumerate(affix_ids):
                lut[lid] = k + 1
            self.register_buffer("affix_target_lut", lut, persistent=False)

        # Separate dependent_locality head (P-B probe, ROAD_TO_MAILWOMAN_V8_1_0 §4). The dead dep-loc tag
        # is resurrected in its OWN head subspace instead of by reinit-ing the shared classifier's rows:
        # a fresh MLP whose 2 logits OWN the B/I-dependent_locality columns (merge-in-forward, exactly like
        # the affix head, so the inference graph carries it). The encoder stays shared+trainable — the probe
        # tests whether growing the capability in a separate head avoids the comma-drop invariance break that
        # every flat-head reinit recipe paid (v3.10–v3.13). init_from v385 (strict=False) leaves this head
        # fresh; the main CE loss trains it via the merged logits.
        self.use_deploc_head = use_deploc_head
        if use_deploc_head:
            self.deploc_head = nn.Sequential(
                nn.Linear(hidden_size, 256),
                nn.GELU(),
                nn.Dropout(0.1),
                nn.Linear(256, 3),  # {O, B-dependent_locality, I-dependent_locality}
            )
            from ..labels import LABEL_TO_ID as _L2I

            deploc_ids = [_L2I["B-dependent_locality"], _L2I["I-dependent_locality"]]
            self.register_buffer("deploc_label_ids", torch.tensor(deploc_ids, dtype=torch.long), persistent=False)

        # Span-boundary auxiliary head (#727, GLiNER-lite probe). A TRAINING-ONLY 2-logit head over the
        # final hidden state predicting, per token, whether an entity span STARTS (a B-* tag) and whether
        # one ENDS here (an entity token whose successor doesn't continue it). The BIO head places tags;
        # this head places boundaries, and the shared encoder must satisfy both — the pressure targets the
        # boundary-absorption residual (a region token pulled into an adjacent street span, "05149 VT
        # Tucker Road" → "VT" absorbed into street). It never touches the exported inference graph (like the
        # locale aux-CE, the loss consumes it and the ONNX path emits only `logits`), so stage-1 carries no
        # export / browser-SLO cost — that is why it is the cheapest #727 falsifier.
        self.use_span_boundary_head = use_span_boundary_head
        self.span_boundary_loss_weight = float(span_boundary_loss_weight)
        if use_span_boundary_head:
            self.span_boundary_head = nn.Linear(hidden_size, 2)  # [start, end] logits
            is_begin = torch.tensor([self.id_to_label[i].startswith("B-") for i in range(num_labels)], dtype=torch.bool)
            is_inside = torch.tensor(
                [self.id_to_label[i].startswith("I-") for i in range(num_labels)], dtype=torch.bool
            )
            self.register_buffer("bio_is_begin", is_begin, persistent=False)
            self.register_buffer("bio_is_inside", is_inside, persistent=False)

        # #727 stage-2 phase 1: the semi-Markov span scorer. Unlike stage-1's aux head (which only
        # shapes the encoder via BCE pressure and is never exported), this is a real scoring path —
        # Phase 2 exports it, Phase 3 decodes it in JS. Default-OFF ⇒ byte-identical: the BIO logits
        # path never reads it, which `test_span_scorer_off_is_byte_identical_to_baseline` enforces.
        self.use_span_scorer = use_span_scorer
        self.span_loss_weight = float(span_loss_weight)
        self.span_scorer: SpanScorer | None = None
        self.semi_crf: SemiMarkovCRF | None = None
        if use_span_scorer:
            self.span_scorer = SpanScorer(hidden_size=hidden_size, span_dim=span_dim, max_span=max_span)
            self.semi_crf = SemiMarkovCRF(max_span=max_span)

        # CRF decoder (Stage 2 / v0.3.0 onwards). Adds ~num_labels² + 2·num_labels learned
        # scalars (483 for 21 labels) — negligible vs the encoder's ~30M parameters.
        # Disabled via use_crf=False for ablation studies or backwards compat with
        # pre-v0.3.0 checkpoints.
        self.crf: LinearChainCRF | None = LinearChainCRF(num_labels, self.id_to_label) if use_crf else None

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

        # Postcode-anchor injection (#239/#240). Per-token additive: a_i = c_i · (W·features +
        # v_ANCHOR), added to the input embedding. anchor_confidence carries the curriculum-perturbed
        # confidence (0 outside any postcode span / absent postcode), so c=0 tokens get a_i=0 with no
        # regime switch. Absent features default to zeros — the well-defined "no anchor" inference path.
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

    def _compute_losses(
        self,
        *,
        hidden: torch.Tensor,
        logits: torch.Tensor,
        labels: torch.Tensor | None,
        attention_mask: torch.Tensor | None,
        locale_ids: torch.Tensor | None,
        locale_logits: torch.Tensor | None,
        affix_logits: torch.Tensor | None,
    ) -> tuple[torch.Tensor | None, torch.Tensor | None]:
        """The supervised loss, its auxiliary terms, and the span scores.

        Four terms can contribute, each gated independently: token CE (with the optional CRF NLL
        beside it), the affix head's own CE, the locale auxiliary CE, the span-boundary BCE, and the
        semi-Markov span NLL. Every one of them is summed into the same scalar and none of them is
        visible in `logits`, so a term that stops firing changes what the model learns and nothing
        the inference path returns.

        Answers `None` for the loss when no term fired, which is inference. The span scores come
        back separately because they are an output, not a loss: the export path reads them.
        """
        loss: torch.Tensor | None = None
        if labels is not None:
            ce_logits = logits
            if self.use_conventions_loss_mask and locale_ids is not None:
                # IGNORE_INDEX rows clamp to locale 0 (US), whose mask row is all-zero — a no-op.
                rows = self.conventions_forbidden[locale_ids.clamp_min(0)]  # (B, num_labels)
                ce_logits = logits.masked_fill(rows.unsqueeze(1).bool(), -1e9)
            ce_kwargs: dict[str, Any] = {
                "ignore_index": -100,
                "label_smoothing": self.label_smoothing,
            }
            # v0.4.0: optional per-class CE weights to compensate for v0.3.0's coarse
            # regression under the 21-label space. See ModelConfig.class_weights docs.
            if isinstance(self.class_weights, torch.Tensor):
                ce_kwargs["weight"] = self.class_weights
            ce_loss = nn.functional.cross_entropy(
                ce_logits.view(-1, self.num_labels),
                labels.view(-1),
                **ce_kwargs,
            )
            if self.use_affix_head and affix_logits is not None:
                # Affix-head CE over its 5 classes; targets via the label lut (ignore -100 rows).
                safe = labels.clamp_min(0)
                affix_targets = self.affix_target_lut[safe]
                affix_targets = torch.where(labels.eq(-100), torch.full_like(affix_targets, -100), affix_targets)
                affix_loss = nn.functional.cross_entropy(
                    affix_logits.view(-1, 5), affix_targets.view(-1), ignore_index=-100
                )
                ce_loss = ce_loss + affix_loss
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

        # Span-boundary auxiliary loss (#727). Per-token BCE on span START (B-*) and END (entity token
        # whose successor doesn't continue it), supervised from the BIO labels. Computed in fp32 — the
        # CRF NaN scar (v0.6.0) says any structural/transition-style leg gets fp32 headroom, and BCE
        # over masked positions is cheap. Masked to real, non-ignore tokens; a batch with no valid
        # position contributes nothing (guards the 0/0 → NaN edge).
        if (
            self.use_span_boundary_head
            and labels is not None
            and attention_mask is not None
            and self.span_boundary_loss_weight > 0
        ):
            valid = attention_mask.bool() & labels.ne(-100)  # (B, S)
            if bool(valid.any()):
                safe = labels.clamp_min(0)
                is_b = self.bio_is_begin[safe]  # (B, S) bool
                is_i = self.bio_is_inside[safe]
                in_entity = is_b | is_i
                # END: an entity token whose next token is not an I- continuation (BIO-valid → same entity).
                next_is_i = torch.zeros_like(is_i)
                next_is_i[:, :-1] = is_i[:, 1:]
                start_tgt = is_b.float()
                end_tgt = (in_entity & ~next_is_i).float()
                # Run the head in the ambient (autocast) dtype, then upcast the LOGITS to fp32 for a
                # stable BCE — the same pattern the locale aux-CE uses (`locale_logits.float()`). Upcasting
                # `h` before the matmul instead would clash with the bf16 head weights (mat1/mat2 dtype).
                sb_logits = self.span_boundary_head(hidden)  # (B, S, 2), ambient dtype
                targets = torch.stack([start_tgt, end_tgt], dim=-1)  # (B, S, 2)
                per_pos = nn.functional.binary_cross_entropy_with_logits(
                    sb_logits.float(), targets, reduction="none"
                ).mean(dim=-1)  # (B, S)
                sb_loss = per_pos[valid].mean()
                sb_term = self.span_boundary_loss_weight * sb_loss
                loss = sb_term if loss is None else loss + sb_term.to(loss.dtype)

        # #727 stage-2 phase 1: the semi-Markov span loss. fp32 throughout (the DP owns its upcast).
        # Rows whose gold segmentation exceeds `max_span` are SKIPPED, not truncated — a truncated
        # gold teaches a wrong boundary, which is the exact defect this arc exists to fix.
        span_scores_out: torch.Tensor | None = None

        if self.use_span_scorer and self.span_scorer is not None:
            span_scores_out = self.span_scorer(hidden)

            if labels is not None and attention_mask is not None and self.span_loss_weight > 0:
                assert self.semi_crf is not None  # nosec B101 — type narrowing; built in __init__ when use_span_scorer
                lengths = attention_mask.sum(dim=1).long()
                row_idxs: list[int] = []
                segs: list[list[tuple[int, int, int]]] = []

                for b_i in range(labels.shape[0]):
                    n = int(lengths[b_i])
                    row_segs, representable = gold_segments(labels[b_i, :n].tolist(), self.span_scorer.max_span)

                    if representable and row_segs:
                        row_idxs.append(b_i)
                        segs.append(row_segs)

                if row_idxs:
                    idx = torch.tensor(row_idxs, device=span_scores_out.device)
                    span_nll = self.semi_crf.nll(
                        span_scores_out.index_select(0, idx), segs, lengths.index_select(0, idx)
                    ).mean()
                    span_term = self.span_loss_weight * span_nll
                    loss = span_term if loss is None else loss + span_term.to(loss.dtype)

        return loss, span_scores_out

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

    # ---- HuggingFace-compatible save/load helpers

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
    from ..labels import resolve_label_set

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
