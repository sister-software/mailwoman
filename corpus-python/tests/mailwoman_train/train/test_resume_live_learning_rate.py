"""A resumed run trains at the LIVE config's learning rates, not the checkpoint's.

`optim.load_state_dict()` overwrites every param group's `lr` and `initial_lr` with the values the
CHECKPOINT saved, and `scheduler.load_state_dict()` does it again to the scheduler's base rates. So
the live rates have to be captured before either load and re-stamped after both — which `setup.py`
calls its one load-bearing ordering, and which nothing exercised end to end:
`test_resume_lr_restamp.py` calls `restamp_resume_lrs` with hand-built inputs, so it never sees
where the live rates come from, and the trace test never resumes.

The assertion compares the resumed optimizer against the SAME optimizer read before the resume,
which is an independent read of the fresh state rather than a second call to the capture under
test. Confirmed by inverting it: halving the captured rates in `build_optimization` leaves every
other test in the suite green, and fails this one.

The config carries TWO rates — `train.learning_rate` and the `classifier_learning_rate` carve-out —
so the check is per group. A single-group assertion would have read the carve-out as a failure.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import torch

from mailwoman_train.config import Config, load_config
from mailwoman_train.corpora.builder import SCHEMA
from mailwoman_train.tokenizer.char import build_char_vocab, save_char_vocab
from mailwoman_train.train.setup import (
    Optimization,
    build_optimization,
    load_or_build_model,
    resolve_tokenizer,
    restore_training_state,
)
from tests import paths

PROBE_2K = paths.CONFIGS / "v8-cjk-full-2k.yaml"

#: The rate the checkpoint was written at, and the one a resume is configured with. Different by
#: construction: if they matched, the test would pass whichever one survived.
CHECKPOINT_LR = 5e-4
LIVE_LR = 2e-5

ROWS: list[dict[str, Any]] = [
    {
        "raw": "東京都千代田区丸の内1",
        "tokens": ["東京都千代田区丸の内1"],
        "labels": ["B-prefecture"],
        "span_starts": [0, 3, 7],
        "span_ends": [3, 7, 10],
        "span_tags": ["prefecture", "municipality", "district"],
        "country": "JP",
        "source": "overture-jp",
        "register": "native",
    },
]


def _config(root: Path, learning_rate: float) -> Config:
    corpus = root / "corpus"
    for split in ("train", "val"):
        (corpus / split).mkdir(parents=True, exist_ok=True)
        pq.write_table(pa.Table.from_pylist(ROWS, schema=SCHEMA), corpus / split / "part-0000.parquet")
    vocab_path = corpus / "char-vocab.json"
    save_char_vocab(build_char_vocab([str(row["raw"]) for row in ROWS], min_count=1), vocab_path)

    cfg = load_config(PROBE_2K)
    cfg.data.source_weights = None
    cfg.data.corpus_dir = str(corpus)
    cfg.data.char_vocab_path = str(vocab_path)
    cfg.train.output_dir = str(root / "output")
    cfg.train.learning_rate = learning_rate
    cfg.train.max_steps = 4
    cfg.train.warmup_steps = 1
    return cfg


def _fresh_optimization(cfg: Config) -> Optimization:
    """A model and optimizer built from `cfg`, the way a from-scratch run would start."""
    tokenizer, char_vocab_size = resolve_tokenizer(cfg)
    device = torch.device("cpu")
    model = load_or_build_model(
        cfg, resume_from=None, tokenizer=tokenizer, char_vocab_size=char_vocab_size, device=device
    )
    return build_optimization(cfg, model)


def _initial_lrs(optimization: Optimization) -> list[float]:
    """Read straight off the param groups — not from `live_group_lrs`, which is what is under test."""
    return [float(group["initial_lr"]) for group in optimization.optimizer.param_groups]


def _write_checkpoint(root: Path, cfg: Config) -> Path:
    """An optimizer + scheduler state saved from `cfg`, the way a real run would leave one."""
    optimization = _fresh_optimization(cfg)
    checkpoint = root / "step-000002"
    checkpoint.mkdir(parents=True, exist_ok=True)
    torch.save(optimization.optimizer.state_dict(), checkpoint / "optimizer.pt")
    torch.save(optimization.scheduler.state_dict(), checkpoint / "scheduler.pt")
    (checkpoint / "training_state.json").write_text(json.dumps({"step": 2, "config": {}}), encoding="utf-8")
    return checkpoint


def test_the_two_configs_differ_where_the_test_reads(tmp_path: Path) -> None:
    """Sanity: if the checkpoint and the live config agreed, the assertion below would prove nothing."""
    checkpoint_lrs = _initial_lrs(_fresh_optimization(_config(tmp_path / "old", CHECKPOINT_LR)))
    live_lrs = _initial_lrs(_fresh_optimization(_config(tmp_path / "new", LIVE_LR)))
    assert checkpoint_lrs != live_lrs, "the fixture's two configs build identical optimizers"
    assert live_lrs[0] == LIVE_LR, f"the base group does not carry train.learning_rate: {live_lrs}"


def test_a_resume_keeps_the_live_learning_rates(tmp_path: Path) -> None:
    checkpoint = _write_checkpoint(tmp_path / "old", _config(tmp_path / "old", CHECKPOINT_LR))

    live_cfg = _config(tmp_path / "new", LIVE_LR)
    optimization = _fresh_optimization(live_cfg)
    before_resume = _initial_lrs(optimization)

    resume_step = restore_training_state(live_cfg, checkpoint, optimization)

    assert resume_step == 2, "the resume did not read the checkpoint's step"
    assert _initial_lrs(optimization) == before_resume, (
        "the resume left the checkpoint's peak rates in place; the live config's were captured "
        "after a load, or not re-stamped after both"
    )
    assert list(optimization.scheduler.base_lrs) == before_resume, (
        "the scheduler still decays from the checkpoint's base rates"
    )
