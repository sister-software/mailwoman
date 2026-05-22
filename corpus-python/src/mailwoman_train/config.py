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
    # v0.3.0+ training-time toggles. build_model passes these through to the encoder.
    # Default False / 0.0 keeps v0.2.0 behavior for back-compat with older configs.
    use_crf: bool = False
    label_smoothing: float = 0.0


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
            setattr(dst, k, v)


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
