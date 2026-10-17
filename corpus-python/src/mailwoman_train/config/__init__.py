"""Run configuration: the typed schema and the strict loader."""

from .load import admitted_sources, csv_log_path, load_config, load_training_config, merge_into
from .schema import (
    Config,
    CorpusReceiptConfig,
    DataConfig,
    EvalConfig,
    LabelSupportConfig,
    ModelConfig,
    TrainConfig,
    ValidationCoverageConfig,
)

__all__ = [
    "Config",
    "CorpusReceiptConfig",
    "DataConfig",
    "EvalConfig",
    "LabelSupportConfig",
    "ModelConfig",
    "TrainConfig",
    "ValidationCoverageConfig",
    "admitted_sources",
    "csv_log_path",
    "load_config",
    "load_training_config",
    "merge_into",
]
