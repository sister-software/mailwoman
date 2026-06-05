"""YAML config loader for the Phase 2 training pipeline.

Keep configs flat and explicit; nothing reads env vars at import time. The default config
lives at ``configs/stage1-coarse.yaml`` and is what ``train.py`` consumes if ``--config`` is
omitted.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


@dataclass
class DataConfig:
    corpus_dir: str = "/data/corpus/versioned/v0.1.0/corpus-v0.1.0"
    tokenizer_dir: str = "/data/models/tokenizer/v0.1.0"
    max_length: int = 128
    # Per-country sampling weights for the train split. Anything not listed gets dropped.
    country_weights: dict[str, float] = field(default_factory=lambda: {"US": 1.0, "FR": 1.0})
    # Per-source sampling weights, keyed on adapter id (e.g. "ban", "tiger", "usgov-nppes").
    # When None (default): all sources pass, no source-level filtering.
    # When set: rows from unlisted sources are dropped. Weight / max_weight acceptance
    # multiplies with country_weights — a row must pass both filters to survive.
    source_weights: dict[str, float] | None = None
    # Hard cap on how many rows the streaming loader yields per epoch (None = unlimited).
    train_rows_per_epoch: int | None = None
    val_rows: int | None = 4096
    # Filter: keep only rows with country + at least one of (region, locality, postcode).
    coarse_filter: bool = True
    # Training augmentation: expand abbreviations to teach token equivalence.
    # Probability (0-1) that each augmentation fires per row. 0 = disabled.
    augment_directional_prob: float = 0.0
    augment_region_prob: float = 0.0
    # Postcode-anchor lookup (#239/#240). Path to the JSON {postcode: [posterior, lat, lon]} table
    # (built by scripts/build-pilot-anchor-lookup.py). When set AND model.use_postcode_anchor is on,
    # the loader projects per-piece anchor features onto each row. None → no anchor features.
    anchor_lookup_path: str | None = None


@dataclass
class ModelConfig:
    # Per-token embedding width and transformer body hidden dim. v0.3.0/v0.4.0 shipped at
    # 256 on a 9M-param encoder; v0.5.0's Thread C scaffold preserves that baseline so the
    # phrase-prior conditioning's contribution can be ablated cleanly against v0.4.0
    # numerics. The Phase 8 plan recommends a 256 → 384 or 512 bump for the v0.5.0 full
    # train ("likely paid for by rented GPU") but only after the new architecture is
    # validated stable at the current size. Bump becomes a follow-up
    # `v0_5_0-classifier-large.yaml` recipe once the baseline lands clean.
    hidden_size: int = 256
    num_hidden_layers: int = 6
    num_attention_heads: int = 4
    intermediate_size: int = 1024
    max_position_embeddings: int = 128
    type_vocab_size: int = 1
    hidden_dropout_prob: float = 0.1
    attention_probs_dropout_prob: float = 0.1
    # v0.3.0+ training-time toggles. build_model passes these through to the encoder.
    # Default False / 0.0 keeps v0.2.0 behavior for back-compat with older configs.
    use_crf: bool = False
    label_smoothing: float = 0.0
    # Weight on the CRF NLL leg of the dual loss (CE + crf_loss_weight × CRF_NLL).
    # With ``crf_normalization=per_sequence`` (v0.3.0 default), the CRF NLL is per-
    # sequence and unbounded (~10–100x CE's per-token magnitude), so 0.05–0.1 is
    # typical to keep CRF as a structural regularizer. With ``per_token`` (v0.4.0),
    # the two losses are comparable in magnitude and the weight can be 1.0 cleanly.
    crf_loss_weight: float = 0.1
    # v0.4.0: CRF NLL normalization. ``"per_sequence"`` = v0.3.0 mean-over-batch
    # (preserves backward compat with old configs). ``"per_token"`` = sum NLL across
    # batch / total real tokens — self-balances against per-token CE, eliminates
    # ``crf_loss_weight`` hand-tuning, matches AllenNLP/FLAIR defaults.
    crf_normalization: str = "per_sequence"
    # v0.6.2 diagnostic flag: force the CRF forward to compute in fp32 while the rest of
    # the model continues in bf16. Tests the 2026-05-28 postmortem's hypothesis that the
    # 33×33 transition table with masked -inf entries is numerically unstable under bf16's
    # 7-bit mantissa. Default False keeps existing configs bit-identical.
    crf_fp32: bool = False
    # v0.4.0: optional per-class CE weights, keyed on BIO label ("O", "B-locality", ...).
    # ``None`` (default) = uniform weighting. Recipe per issue #116: derive from corpus
    # label-frequency as ``(1 / class_freq) ** 0.5``, then halve fine-class weights
    # (venue/street/house_number) to re-prioritize coarse-class recovery. See
    # configs/v0_4_0.yaml for the worked example.
    class_weights: dict[str, float] | None = None
    # v0.5.0 thread C: phrase-prior conditioning from Stage 2.7 (Thread E). When True, the
    # encoder forward concatenates a per-token feature row (BIE markers + PhraseKind one-
    # hot) onto the token+position embedding before the first transformer block, and
    # projects back to ``hidden_size`` with a learned linear. Default False preserves
    # v0.3.0/v0.4.0 numerics for ablation studies. See `phrase_priors.py` for the slot
    # layout + ``the-knowledge-ladder.md`` § Phrase grouper for the design rationale.
    use_phrase_priors: bool = False
    # Per-token feature width. Determined by the phrase-priors taxonomy; surfaced as a
    # config field so corpus-side feature shape and model-side projection width stay
    # in lockstep through the model-card layer.
    phrase_feature_dim: int = 10  # = PHRASE_BIE_DIM (3) + PHRASE_KIND_DIM (7)
    # PR3: self-conditioning. When True, the encoder pools its output into a locale posterior
    # (an auxiliary head over the labels.LOCALE_COUNTRIES vocabulary, trained on the corpus
    # ``country`` field) and FiLM-modulates the per-token representations by it before the BIO
    # head — the model infers "which country" globally, then conditions its own labeling on it.
    # The head is exported as the LocalePosterior the resolver consumes. Default False keeps
    # v0.8.x numerics for back-compat. ``num_locales`` is NOT a yaml knob — build_model derives
    # it from labels.NUM_LOCALES so the head width and the target vocabulary can never drift.
    use_locale_conditioning: bool = False
    # Weight on the auxiliary locale cross-entropy leg (loss = BIO_CE + crf + locale_loss_weight ×
    # locale_CE). 0.0 disables the aux loss even when conditioning is on (the FiLM path still runs
    # unsupervised, which is rarely what you want); a value like 0.3 keeps the locale signal a
    # genuine but secondary objective behind the per-token BIO task.
    locale_loss_weight: float = 0.0
    # Postcode-anchor conditioning channel (#239/#240 de-risk pilot). When True, the encoder takes a
    # per-token ``(B, S, NUM_LOCALES+2)`` anchor-feature tensor (uniform country posterior + centroid)
    # and a ``(B, S)`` confidence scalar, and injects ``c·(W·features + v_ANCHOR)`` at the input
    # embedding — a position-local hard cue at the postcode span (the property self-conditioning's
    # global FiLM lacked). Robustness is the confidence curriculum applied corpus-side (see the data
    # loader). Default False keeps existing numerics. Composes with ``use_locale_conditioning``.
    use_postcode_anchor: bool = False


@dataclass
class TrainConfig:
    output_dir: str = "/data/models/checkpoints/stage1-coarse"
    seed: int = 42
    batch_size: int = 256
    eval_batch_size: int = 512
    grad_accum_steps: int = 1
    learning_rate: float = 5e-4
    weight_decay: float = 0.01
    warmup_steps: int = 1000
    max_steps: int = 50000
    eval_every_steps: int = 2000
    save_every_steps: int = 5000
    log_every_steps: int = 100
    precision: str = "fp32"  # one of: fp32 | fp16 | bf16
    num_workers: int = 2
    csv_log_path: str = "{output_dir}/train_log.csv"
    # Global-norm gradient clip. 0 disables clipping. Defaults to 1.0; the CRF NLL leg of
    # Stage 2 emits sharp gradients during warmup and diverged at the LR peak without it.
    grad_clip_norm: float = 1.0
    # LR schedule after warmup. ``"cosine"`` = decay to 0 across max_steps (v0.4.0 default,
    # right for full-length production runs). ``"constant"`` = hold ``learning_rate`` flat
    # for the rest of the run after warmup — the smoke-window default per v0.5.0 process
    # (see docs/articles/plan/reference/VERDICT_SMOKES.md). Cosine decay during a short
    # smoke window masks divergence by collapsing LR before the loss curve shows it; the
    # constant-LR mode keeps the signal visible. See the ref doc for when to pick which.
    lr_schedule: str = "cosine"
    # Training objective. "supervised" = the BIO token-classification loss (CE + optional CRF, the
    # default and only historical mode). "mlm" = self-supervised masked-language-model PRE-training
    # on the corpus text (BIO labels ignored): masks `mlm_mask_prob` of attended tokens and predicts
    # them via the tied token-embedding head, producing an encoder checkpoint a later supervised run
    # fine-tunes from (`init_from`). See pretrain.py. Off the supervised path entirely.
    objective: str = "supervised"
    # Fraction of attended (non-pad) tokens masked for the MLM objective. 0.15 is BERT-classic; the
    # small-encoder literature favors ~0.4 — tune per experiment. Ignored unless objective == "mlm".
    mlm_mask_prob: float = 0.15
    # Initialize MODEL weights from this checkpoint dir at the start of a SUPERVISED run, WITHOUT
    # loading optimizer/scheduler/step (unlike resume). This is how a fine-tune run starts from an
    # MLM-pretrained encoder. Empty = fresh init. Ignored when resuming (resume takes precedence).
    init_from: str = ""
    # Trackio experiment tracking (Hugging Face). Off by default so existing configs and
    # plain/CI runs stay bit-identical and never depend on the optional 'trackio' package.
    # When enabled, the metrics written to train_log.csv are also streamed to a Trackio
    # project (see trackio_logging.py). All tracking is best-effort: a failure degrades to
    # CSV-only and never aborts the run.
    trackio_enabled: bool = False
    trackio_project: str = "mailwoman"
    # HF Space id for the hosted dashboard, e.g. "sister-software/mailwoman-trackio".
    # The Space is auto-created on first run if it doesn't exist. Empty = local-only
    # dashboard (~/.cache/huggingface/trackio), no HF upload.
    trackio_space: str = ""
    # Optional human-readable run name. Empty = derive a stable name from output_dir so
    # a resumed run (resume="auto") continues the same dashboard run instead of forking.
    trackio_run_name: str = ""
    # Make the dashboard Space private (visible to org members only). Defaults True so
    # in-progress training metrics aren't published publicly by accident. Ignored if the
    # Space already exists.
    trackio_private: bool = True


@dataclass
class EvalConfig:
    golden_dir: str = ""  # path to data/eval/golden/v0.1.0/ (in-repo)
    val_jsonl: str = ""  # optional: a hand-curated val.jsonl mirroring golden schema


@dataclass
class Config:
    data: DataConfig = field(default_factory=DataConfig)
    model: ModelConfig = field(default_factory=ModelConfig)
    train: TrainConfig = field(default_factory=TrainConfig)
    eval: EvalConfig = field(default_factory=EvalConfig)


def _merge(dst: Any, src: dict[str, Any]) -> None:
    for k, v in src.items():
        if not hasattr(dst, k):
            raise KeyError(f"unknown config field: {dst.__class__.__name__}.{k}")
        cur = getattr(dst, k)
        if hasattr(cur, "__dataclass_fields__") and isinstance(v, dict):
            _merge(cur, v)
        else:
            setattr(dst, k, _coerce(dst, k, v))


def _coerce(dst: Any, key: str, value: Any) -> Any:
    """Coerce ``value`` to the dataclass field's declared type when an obvious conversion
    is safe. Targets one specific footgun: PyYAML's default loader parses ``5e-4`` as a
    string (YAML 1.1 spec requires a dot for floats), so a YAML config that writes
    ``learning_rate: 5e-4`` silently makes its way into ``AdamW(lr="5e-4")`` and crashes
    with a confusing ``TypeError: '<=' not supported between instances of 'float' and 'str'``.
    Defensive coercion here means the configs work regardless of whether the human used
    YAML 1.1 or YAML 1.2 numeric syntax. Only fires when the declared type is ``float`` or
    ``int`` and the source is a string that parses cleanly — leaves all other values alone.
    """
    fields = getattr(dst.__class__, "__dataclass_fields__", None)
    if not fields or key not in fields:
        return value
    declared = fields[key].type
    if not isinstance(value, str):
        return value
    if declared in (float, "float"):
        try:
            return float(value)
        except ValueError:
            return value
    if declared in (int, "int"):
        try:
            return int(value)
        except ValueError:
            return value
    return value


def load_config(path: str | Path | None) -> Config:
    cfg = Config()
    if path is None:
        return cfg
    p = Path(path)
    with p.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    if not isinstance(data, dict):
        raise ValueError(f"expected top-level mapping in {p}")
    _merge(cfg, data)
    return cfg


def csv_log_path(cfg: Config) -> Path:
    template = cfg.train.csv_log_path
    return Path(template.format(output_dir=cfg.train.output_dir))
