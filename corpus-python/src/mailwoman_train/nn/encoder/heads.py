"""Building the output heads, and the weight initialization that follows them.

Construction order is a contract: `_init_weights` walks `self.parameters()`, which yields in
registration order and draws from the global RNG for each, so moving a head's construction changes
the initial weights of everything registered after it.
"""

from __future__ import annotations

import torch
from torch import nn

from ..crf import LinearChainCRF
from ..span_scorer import SemiMarkovCRF, SpanScorer
from .state import CoarseEncoderState


class CoarseEncoderHeads(CoarseEncoderState):
    """The head construction and weight initialization half of `MailwomanCoarseEncoder`."""

    def _build_heads(
        self,
        *,
        hidden_size: int,
        num_labels: int,
        use_locale_conditioning: bool,
        num_locales: int,
        locale_loss_weight: float,
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
        """The output heads, in two groups that differ in what they touch.

        The merge heads OWN columns of the classifier's output: their logits replace specific label
        columns in `forward`, so they reach the exported graph and change what inference predicts.
        The structured heads sit beside the classifier — the CRF decodes its output, the span scorer
        and span-boundary head score it — and touch no column.

        Do not reorder these, and keep the calls where they sit in `__init__`. Registration order
        decides what `_init_weights` draws for each parameter, so a move changes the initial
        weights of every parameter registered after it and a from-scratch run stops reproducing
        earlier ones.
        """
        # PR3 self-conditioning: an auxiliary locale head over the pooled sequence, plus a FiLM
        # modulation of the per-token reps by the inferred locale. `forward` carries the data flow.
        self.use_locale_conditioning = use_locale_conditioning
        self.num_locales = int(num_locales)
        self.locale_loss_weight = float(locale_loss_weight)
        self._build_merge_heads(
            hidden_size=hidden_size,
            num_labels=num_labels,
            use_conventions_loss_mask=use_conventions_loss_mask,
            use_affix_head=use_affix_head,
            use_deploc_head=use_deploc_head,
        )
        self._build_structured_heads(
            hidden_size=hidden_size,
            num_labels=num_labels,
            use_span_boundary_head=use_span_boundary_head,
            span_boundary_loss_weight=span_boundary_loss_weight,
            use_span_scorer=use_span_scorer,
            span_loss_weight=span_loss_weight,
            span_dim=span_dim,
            max_span=max_span,
            use_crf=use_crf,
        )

    def _build_merge_heads(
        self,
        *,
        hidden_size: int,
        num_labels: int,
        use_conventions_loss_mask: bool,
        use_affix_head: bool,
        use_deploc_head: bool,
    ) -> None:
        """Heads whose logits replace columns of the classifier's output."""
        # Dedicated affix head (#492): MLP over [final hidden ; raw gazetteer 5-dim skip] ->
        # {O, B-street_prefix, I-street_prefix, B-street_suffix, I-street_suffix}. The gaz vector
        # skip-connects PAST the encoder so the head owns the clue->affix mapping (consult
        # 2026-06-10); independent dropout on the skip layers robustness locally. Its 4 affix
        # logits replace the main classifier's affix columns in forward (merge-in-forward).
        # Train-time conventions pairing (#478): per-locale forbidden-label mask applied to the
        # CE input only (returned logits untouched — inference behavior is the codex mask's job).
        self.use_conventions_loss_mask = bool(use_conventions_loss_mask)
        if self.use_conventions_loss_mask:
            from ...features.conventions import build_forbidden_mask
            from ...labels import LABEL_TO_ID

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
            from ...labels import LABEL_TO_ID

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
            from ...labels import LABEL_TO_ID as _L2I

            deploc_ids = [_L2I["B-dependent_locality"], _L2I["I-dependent_locality"]]
            self.register_buffer("deploc_label_ids", torch.tensor(deploc_ids, dtype=torch.long), persistent=False)

    def _build_structured_heads(
        self,
        *,
        hidden_size: int,
        num_labels: int,
        use_span_boundary_head: bool,
        span_boundary_loss_weight: float,
        use_span_scorer: bool,
        span_loss_weight: float,
        span_dim: int,
        max_span: int,
        use_crf: bool,
    ) -> None:
        """Heads that score or decode the classifier's output without replacing any of it."""
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
