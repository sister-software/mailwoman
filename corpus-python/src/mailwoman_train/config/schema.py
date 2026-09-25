from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class CorpusReceiptConfig:
    name: str = ""
    min_draws: int = 1
    source: str | None = None
    country: str | None = None
    component_sequence: list[str] = field(default_factory=list)


@dataclass
class ValidationCoverageConfig:
    country: str = ""
    split: str = "val"
    min_rows: int = 1
    min_street_rows: int = 0


@dataclass
class DataConfig:
    corpus_dir: str = "/data/corpus/versioned/v0.1.0/corpus-v0.1.0"
    tokenizer_dir: str = "/data/models/tokenizer/v0.1.0"
    max_length: int = 128

    country_weights: dict[str, float] = field(default_factory=lambda: {"US": 1.0, "FR": 1.0})

    source_weights: dict[str, float] | None = None

    source_reps: dict[str, float] | None = None

    required_corpus_receipts: list[CorpusReceiptConfig] = field(default_factory=list)

    required_validation_coverage: list[ValidationCoverageConfig] = field(default_factory=list)

    train_rows_per_epoch: int | None = None
    val_rows: int | None = 4096

    coarse_filter: bool = True

    augment_directional_prob: float = 0.0
    augment_region_prob: float = 0.0

    augment_glue_prob: float = 0.0

    augment_ordinal_prob: float = 0.0

    augment_case_prob: float = 0.0

    augment_punct_drop_prob: float = 0.0
    augment_upper_case_prob: float = 0.0

    augment_exclude_sources: list[str] = field(default_factory=list)

    anchor_lookup_path: str | None = None

    gazetteer_lexicon_path: str | None = None

    country_lexicon_path: str | None = None

    street_type_lexicon_path: str | None = None

    locality_surface_lexicon_path: str | None = None

    gazetteer_choreography: bool = False

    char_mode: str = "off"

    char_vocab_path: str | None = None

    char_ctx: int = 0

    max_unit_width: int = 16

    max_units: int | None = None

    label_set: str = "stage3"

    affix_relabel_lexicon_path: str | None = None

    anchor_paint_mode: str = "gold"

    anchor_value_mode: str = "posterior_latlon"

    region_centroids_path: str | None = None

    def __post_init__(self) -> None:
        for key in self.country_weights:
            if not isinstance(key, str):
                raise ValueError(
                    f"country_weights has a non-string key {key!r} ({type(key).__name__}). "
                    "This is almost certainly the YAML 1.1 Norway problem: an unquoted `NO:` parses "
                    'as the boolean false. Quote it — `"NO": 1.0` — and re-check every other code.'
                )


@dataclass
class ModelConfig:
    hidden_size: int = 256
    num_hidden_layers: int = 6
    num_attention_heads: int = 4
    intermediate_size: int = 1024
    max_position_embeddings: int = 128
    type_vocab_size: int = 1
    hidden_dropout_prob: float = 0.1
    attention_probs_dropout_prob: float = 0.1

    use_crf: bool = False
    label_smoothing: float = 0.0

    crf_loss_weight: float = 0.1

    crf_normalization: str = "per_sequence"

    crf_fp32: bool = False

    class_weights: dict[str, float] | None = None

    use_phrase_priors: bool = False

    phrase_feature_dim: int = 10

    use_locale_conditioning: bool = False

    locale_loss_weight: float = 0.0

    use_postcode_anchor: bool = False

    inject_first_token: bool = False

    use_gazetteer_anchor: bool = False

    use_affix_head: bool = False

    use_deploc_head: bool = False

    use_conventions_loss_mask: bool = False

    use_span_boundary_head: bool = False
    span_boundary_loss_weight: float = 0.0

    use_span_scorer: bool = False
    span_loss_weight: float = 0.0
    span_dim: int = 128
    max_span: int = 8

    gazetteer_feature_dim: int = 5

    use_country_anchor: bool = False

    country_feature_dim: int = 2

    country_ambiguous_scale: float = 1.0

    use_street_type_anchor: bool = False

    street_type_feature_dim: int = 1

    use_locality_surface_anchor: bool = False

    locality_surface_feature_dim: int = 2

    use_char_embed: bool = False
    char_embed_dim: int = 64
    char_kernel_sizes: list[int] = field(default_factory=lambda: [3, 4, 5])


@dataclass
class TrainConfig:
    output_dir: str = "/data/models/checkpoints/stage1-coarse"
    seed: int = 42
    batch_size: int = 256
    eval_batch_size: int = 512
    grad_accum_steps: int = 1
    learning_rate: float = 5e-4
    weight_decay: float = 0.01

    span_head_learning_rate: float | None = None

    classifier_learning_rate: float | None = None

    reinit_label_rows: list[str] = field(default_factory=list)
    warmup_steps: int = 1000
    max_steps: int = 50000
    eval_every_steps: int = 2000
    save_every_steps: int = 5000
    log_every_steps: int = 100
    precision: str = "fp32"
    num_workers: int = 2
    csv_log_path: str = "{output_dir}/train_log.csv"

    grad_clip_norm: float = 1.0

    fisher_capture: bool = False
    fisher_capture_last_n_steps: int = 2000

    ewc_lambda: float = 0.0
    ewc_fisher_path: str | None = None
    ewc_reference: str | None = None

    lr_schedule: str = "cosine"

    cooldown_start_step: int | None = None

    gazetteer_curriculum: bool = False

    evidence_curriculum: bool = False

    evidence_noise_prob: float = 0.0

    objective: str = "supervised"

    mlm_mask_prob: float = 0.15

    init_from: str = ""

    freeze_encoder: bool = False

    freeze_token_embeddings: bool = False

    trainable_only_prefixes: list[str] = field(default_factory=list)

    trackio_enabled: bool = False
    trackio_project: str = "mailwoman"

    trackio_space: str = ""

    trackio_run_name: str = ""

    trackio_private: bool = True


@dataclass
class EvalConfig:
    golden_dir: str = ""
    val_jsonl: str = ""


@dataclass
class Config:
    data: DataConfig = field(default_factory=DataConfig)
    model: ModelConfig = field(default_factory=ModelConfig)
    train: TrainConfig = field(default_factory=TrainConfig)
    eval: EvalConfig = field(default_factory=EvalConfig)
