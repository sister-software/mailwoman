"""Training loop for the Stage 1 coarse token-classification model.

Per Phase 2 §4 plan:

- Optimizer: AdamW, lr 5e-4, weight decay 0.01.
- LR schedule: linear warmup ``warmup_steps`` → cosine decay to 0 over ``max_steps``.
- Batch size: 256 (configurable).
- Mixed precision: fp16/bf16 on GPU (``precision`` in config); fp32 on CPU.
- Save checkpoint every N steps to ``output_dir/step-XXXX/``.
- Track train loss + val loss + val per-component F1 + full-parse exact match in a plain CSV.
- One logging backend (CSV) — picked per the Phase 2 plan's "don't ship a logging refactor
  in the middle of training" guidance.

The eval invoked here is a *streaming* val-set eval (token-level F1 over the val parquet
split). The richer golden-set eval lives in ``eval.py`` and is meant to run post-training.

`train()` below is the ORDER the stages run in, and nothing else: `setup.py` holds what a run
decides before its first batch, `loop.py` holds the optimizer loop, and the callbacks hold what is
written as it goes. `tests/mailwoman_train/train/test_train_loop_trace.py` pins the CSV shape, the
event order and the final per-parameter weights, so a stage that moves is a failing test rather
than a changed model.
"""

from __future__ import annotations

import random
import time
from pathlib import Path

import torch

from ..config import Config
from ..data.dose import format_derivation, resolve_config_doses
from ..data.loader import IGNORE_INDEX, iter_batches
from ..evaluation.metrics import cross_pollution, token_f1
from ..nn.encoder import force_math_sdpa
from ..protocols import TrainCallback
from ..tokenizer import Tokenizer
from .batch import to_tensor_batch
from .callbacks import default_callbacks
from .checkpoint import find_latest_checkpoint
from .loop import run_training_loop
from .setup import (
    apply_freezes,
    build_optimization,
    build_regularizers,
    load_or_build_model,
    resolve_precision,
    resolve_tokenizer,
    restore_training_state,
)
from .state import TrainState


def _set_seed(seed: int) -> None:
    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


@torch.no_grad()
def _eval_val(
    cfg: Config,
    tokenizer: Tokenizer | None,
    model: torch.nn.Module,
    device: torch.device,
    max_rows: int | None,
) -> dict[str, float]:
    """Streaming val-set eval. Returns mean val loss + token-level macro F1 + (PR3) the
    cross-pollution regression check and the aux locale-head accuracy when self-conditioning is on.

    ``tokenizer`` is None on the char path (``char_mode: char`` skips SentencePiece entirely) and
    ``iter_batches`` encodes per character in that case; the val eval runs there like the train loop
    does. A guard that refused a None tokenizer here stopped every char-mode run at its first eval."""
    model.eval()
    loss_total = 0.0
    seen_batches = 0
    all_preds: list[torch.Tensor] = []
    all_labels: list[torch.Tensor] = []
    all_locale_ids: list[torch.Tensor] = []
    all_locale_preds: list[torch.Tensor] = []
    rows_seen = 0
    for batch in iter_batches(
        cfg,
        tokenizer,
        split="val",
        batch_size=cfg.train.eval_batch_size,
        seed=cfg.train.seed + 1,
        row_limit=max_rows,
    ):
        tb = to_tensor_batch(batch, device)
        out = model(**tb)
        loss_total += float(out.loss.detach().cpu())
        seen_batches += 1
        rows_seen += tb["input_ids"].shape[0]
        all_preds.append(out.logits.argmax(dim=-1).detach().cpu())
        all_labels.append(tb["labels"].detach().cpu())
        if "locale_ids" in tb:
            all_locale_ids.append(tb["locale_ids"].detach().cpu())
        if getattr(out, "locale_logits", None) is not None:
            all_locale_preds.append(out.locale_logits.argmax(dim=-1).detach().cpu())
    if seen_batches == 0:
        return {"val_loss": float("nan"), "val_rows": 0, "macro_f1": 0.0}
    preds = torch.cat(all_preds, dim=0)
    labels = torch.cat(all_labels, dim=0)
    from ..labels import resolve_label_set

    label_set = resolve_label_set(getattr(cfg.data, "label_set", "stage3"))
    metrics = token_f1(preds, labels, num_labels=len(label_set.bio_labels), bio_labels=label_set.bio_labels)
    metrics["val_loss"] = loss_total / seen_batches
    metrics["val_rows"] = rows_seen
    # PR3 regression check + aux-head accuracy.
    row_locale = torch.cat(all_locale_ids, dim=0) if all_locale_ids else None
    metrics.update(cross_pollution(preds, labels, row_locale))
    if all_locale_preds and row_locale is not None:
        locale_pred = torch.cat(all_locale_preds, dim=0)
        valid = row_locale != IGNORE_INDEX
        if int(valid.sum()) > 0:
            metrics["locale_acc"] = float((locale_pred[valid] == row_locale[valid]).float().mean())
    return metrics


def train(
    cfg: Config,
    *,
    resume_from: str | Path | None = None,
    callbacks: list[TrainCallback] | None = None,
) -> None:
    _set_seed(cfg.train.seed)
    # MLM pre-training is a different objective + loop; route there (lazy import avoids a
    # train<->pretrain module cycle). pretrain() writes from_pretrained-loadable checkpoints.
    if getattr(cfg.train, "objective", "supervised") == "mlm":
        from .pretrain import pretrain

        pretrain(cfg, resume_from=resume_from)
        return
    # Mandatory on gfx1103 — flash/mem-efficient SDPA paths crash bf16 on this GPU.
    force_math_sdpa()
    # #1677: a dosed source's weight is derived here, from the corpus's row counts and this run's samples, so
    # the mixture the loader samples is the one the config named in reps per row.
    derived_doses = resolve_config_doses(cfg)
    if derived_doses:
        print(format_derivation(derived_doses), flush=True)
    output_dir = Path(cfg.train.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Auto-detect latest checkpoint when resume_from == "auto" — convenient for restart-on-hang.
    if resume_from == "auto":
        resume_from = find_latest_checkpoint(output_dir)

    tokenizer, char_vocab_size = resolve_tokenizer(cfg)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = load_or_build_model(
        cfg,
        resume_from=resume_from,
        tokenizer=tokenizer,
        char_vocab_size=char_vocab_size,
        device=device,
    )
    apply_freezes(cfg, model)
    optimization = build_optimization(cfg, model)
    precision = resolve_precision(cfg, model, device)
    resume_step = restore_training_state(cfg, resume_from, optimization)
    regularizers = build_regularizers(cfg, model, device)

    state = TrainState(
        cfg=cfg,
        model=model,
        tokenizer=tokenizer,
        device=device,
        optimizer=optimization.optimizer,
        scheduler=optimization.scheduler,
        output_dir=output_dir,
        started=time.time(),
        vocab_size=tokenizer.vocab_size if tokenizer is not None else 2,
    )
    if callbacks is None:
        callbacks = default_callbacks(cfg, resume_step=resume_step)
    for callback in callbacks:
        callback.on_train_begin(state)

    try:
        run_training_loop(
            cfg,
            state,
            callbacks,
            resume_step=resume_step,
            precision=precision,
            regularizers=regularizers,
            evaluate=_eval_val,
        )
    finally:
        # A crashed run still closes its CSV and its tracker, so the partial metrics survive.
        for callback in callbacks:
            callback.on_train_end(state)
