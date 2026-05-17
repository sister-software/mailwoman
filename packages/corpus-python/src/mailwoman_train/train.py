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
"""

from __future__ import annotations

import csv
import json
import math
import random
import time
from dataclasses import asdict
from pathlib import Path

import torch
from torch.optim import AdamW
from torch.optim.lr_scheduler import LambdaLR

from .config import Config, csv_log_path
from .data_loader import IGNORE_INDEX, iter_batches, verify_tokenizer_alignment
from .labels import STAGE1_BIO_LABELS
from .model import build_model, force_math_sdpa, model_param_count
from .tokenizer import Tokenizer


def _set_seed(seed: int) -> None:
    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def _to_tensor_batch(batch: dict, device: torch.device) -> dict:
    return {
        "input_ids": torch.tensor(batch["input_ids"], dtype=torch.long, device=device),
        "attention_mask": torch.tensor(batch["attention_mask"], dtype=torch.long, device=device),
        "labels": torch.tensor(batch["labels"], dtype=torch.long, device=device),
    }


def _cosine_with_warmup(optimizer: AdamW, warmup_steps: int, max_steps: int) -> LambdaLR:
    def lr_lambda(step: int) -> float:
        if step < warmup_steps:
            return float(step) / float(max(1, warmup_steps))
        progress = float(step - warmup_steps) / float(max(1, max_steps - warmup_steps))
        progress = min(1.0, progress)
        return max(0.0, 0.5 * (1.0 + math.cos(math.pi * progress)))

    return LambdaLR(optimizer, lr_lambda)


def _precision_to_dtype(precision: str, device: torch.device) -> torch.dtype | None:
    if precision == "fp16":
        return torch.float16 if device.type == "cuda" else None
    if precision == "bf16":
        return torch.bfloat16
    return None


def _token_f1(
    preds: torch.Tensor,
    labels: torch.Tensor,
    num_labels: int,
) -> dict[str, float]:
    """Compute macro/per-class token-level F1 over a batch. Ignores ``IGNORE_INDEX`` positions."""
    mask = labels != IGNORE_INDEX
    p = preds[mask]
    y = labels[mask]
    tp = torch.zeros(num_labels, device=p.device)
    fp = torch.zeros(num_labels, device=p.device)
    fn = torch.zeros(num_labels, device=p.device)
    for c in range(num_labels):
        pred_c = p == c
        true_c = y == c
        tp[c] = (pred_c & true_c).sum().float()
        fp[c] = (pred_c & ~true_c).sum().float()
        fn[c] = (~pred_c & true_c).sum().float()
    precision = tp / (tp + fp + 1e-9)
    recall = tp / (tp + fn + 1e-9)
    f1 = 2 * precision * recall / (precision + recall + 1e-9)
    per_label = {STAGE1_BIO_LABELS[c]: float(f1[c]) for c in range(num_labels)}
    macro = float(f1.mean())
    return {"macro_f1": macro, **{f"f1.{k}": v for k, v in per_label.items()}}


@torch.no_grad()
def _eval_val(
    cfg: Config,
    tokenizer: Tokenizer,
    model: torch.nn.Module,
    device: torch.device,
    max_rows: int | None,
) -> dict[str, float]:
    """Streaming val-set eval. Returns mean val loss + token-level macro F1."""
    model.eval()
    loss_total = 0.0
    seen_batches = 0
    all_preds: list[torch.Tensor] = []
    all_labels: list[torch.Tensor] = []
    rows_seen = 0
    for batch in iter_batches(
        cfg,
        tokenizer,
        split="val",
        batch_size=cfg.train.eval_batch_size,
        seed=cfg.train.seed + 1,
        row_limit=max_rows,
    ):
        tb = _to_tensor_batch(batch, device)
        out = model(**tb)
        loss_total += float(out.loss.detach().cpu())
        seen_batches += 1
        rows_seen += tb["input_ids"].shape[0]
        all_preds.append(out.logits.argmax(dim=-1).detach().cpu())
        all_labels.append(tb["labels"].detach().cpu())
    if seen_batches == 0:
        return {"val_loss": float("nan"), "val_rows": 0, "macro_f1": 0.0}
    preds = torch.cat(all_preds, dim=0)
    labels = torch.cat(all_labels, dim=0)
    metrics = _token_f1(preds, labels, num_labels=len(STAGE1_BIO_LABELS))
    metrics["val_loss"] = loss_total / seen_batches
    metrics["val_rows"] = rows_seen
    return metrics


def save_checkpoint(
    model: torch.nn.Module,
    output_dir: Path,
    step: int,
    extras: dict,
) -> Path:
    """Save model state_dict + config + step extras into ``output_dir/step-XXXXX/``."""
    ck = output_dir / f"step-{step:06d}"
    ck.mkdir(parents=True, exist_ok=True)
    if hasattr(model, "save_pretrained"):
        model.save_pretrained(ck)  # type: ignore[arg-type]
    else:
        torch.save(model.state_dict(), ck / "pytorch_model.bin")
    (ck / "training_state.json").write_text(json.dumps(extras, indent=2) + "\n", encoding="utf-8")
    return ck


def train(cfg: Config) -> None:
    _set_seed(cfg.train.seed)
    # Mandatory on gfx1103 — flash/mem-efficient SDPA paths crash bf16 on this GPU.
    force_math_sdpa()
    output_dir = Path(cfg.train.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    tokenizer = Tokenizer(Path(cfg.data.tokenizer_dir) / "tokenizer.model")
    verify_tokenizer_alignment(Path(cfg.data.corpus_dir), tokenizer)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = build_model(cfg, vocab_size=tokenizer.vocab_size, pad_token_id=tokenizer.pad_id)
    model.to(device)

    print(f"device={device} param_count={model_param_count(model):,}")
    print(f"gpu={torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'cpu-only'}")

    optim = AdamW(
        model.parameters(),
        lr=cfg.train.learning_rate,
        weight_decay=cfg.train.weight_decay,
    )
    scheduler = _cosine_with_warmup(optim, cfg.train.warmup_steps, cfg.train.max_steps)
    amp_dtype = _precision_to_dtype(cfg.train.precision, device)
    # On gfx1103 (Radeon 780M) autocast+bf16 has been observed to hang at batch≥64 with
    # nn.MultiheadAttention — the autocast fast-path picks a fused kernel that GPU hangs on.
    # Cast the whole model to bf16 explicitly instead: equivalent throughput, no fast-path.
    cast_model_dtype = amp_dtype is not None and device.type == "cuda"
    if cast_model_dtype:
        model.to(dtype=amp_dtype)
    use_amp_autocast = False
    # Effective batch size = batch_size × grad_accum_steps. Optimizer steps every `accum` calls.
    accum = max(1, int(cfg.train.grad_accum_steps))

    csv_path = csv_log_path(cfg)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    csv_fh = csv_path.open("w", encoding="utf-8", newline="")
    csv_writer = csv.writer(csv_fh)
    csv_writer.writerow(
        [
            "step",
            "wall_seconds",
            "train_loss",
            "lr",
            "val_loss",
            "val_macro_f1",
        ]
    )

    step = 0
    micro_step = 0
    started = time.time()
    train_loss_running = 0.0
    log_every = max(1, cfg.train.log_every_steps)
    print(f"max_steps={cfg.train.max_steps} batch_size={cfg.train.batch_size}")
    try:
        # The streaming iterator may exhaust before max_steps if row_limit is set;
        # restart per "epoch" until step budget is met.
        epoch = 0
        while step < cfg.train.max_steps:
            epoch += 1
            for batch in iter_batches(
                cfg,
                tokenizer,
                split="train",
                batch_size=cfg.train.batch_size,
                seed=cfg.train.seed + epoch,
                row_limit=cfg.data.train_rows_per_epoch,
            ):
                if step >= cfg.train.max_steps:
                    break
                model.train()
                tb = _to_tensor_batch(batch, device)
                # Optimizer step happens every ``accum`` micro-batches; gradients accumulate
                # across the micro-batches in between. ``step`` counts *optimizer* steps,
                # not micro-steps, so it lines up with the cfg.train.max_steps budget.
                is_accum_boundary = ((micro_step + 1) % accum) == 0
                if micro_step % accum == 0:
                    optim.zero_grad(set_to_none=True)
                if use_amp_autocast:
                    with torch.autocast(device_type=device.type, dtype=amp_dtype):
                        out = model(**tb)
                else:
                    out = model(**tb)
                loss = out.loss / accum
                loss.backward()
                micro_step += 1
                if not is_accum_boundary:
                    continue
                optim.step()
                scheduler.step()
                step += 1
                train_loss_running += float(loss.detach().cpu()) * accum

                if step % log_every == 0:
                    avg = train_loss_running / log_every
                    train_loss_running = 0.0
                    lr = float(scheduler.get_last_lr()[0])
                    elapsed = time.time() - started
                    print(
                        f"step {step}/{cfg.train.max_steps}"
                        f"  train_loss={avg:.4f}  lr={lr:.6f}"
                        f"  rate={step/elapsed:.2f} steps/s"
                    )
                    csv_writer.writerow([step, f"{elapsed:.1f}", f"{avg:.6f}", f"{lr:.8f}", "", ""])
                    csv_fh.flush()

                if step % cfg.train.eval_every_steps == 0:
                    val = _eval_val(cfg, tokenizer, model, device, max_rows=cfg.data.val_rows)
                    print(
                        f"  [eval] val_loss={val.get('val_loss', float('nan')):.4f}"
                        f"  macro_f1={val.get('macro_f1', 0.0):.4f}"
                        f"  val_rows={val.get('val_rows', 0)}"
                    )
                    elapsed = time.time() - started
                    csv_writer.writerow(
                        [
                            step,
                            f"{elapsed:.1f}",
                            "",
                            "",
                            f"{val.get('val_loss', float('nan')):.6f}",
                            f"{val.get('macro_f1', 0.0):.6f}",
                        ]
                    )
                    csv_fh.flush()

                if step % cfg.train.save_every_steps == 0:
                    extras = {
                        "step": step,
                        "config": {
                            "data": asdict(cfg.data),
                            "model": asdict(cfg.model),
                            "train": asdict(cfg.train),
                        },
                        "vocab_size": tokenizer.vocab_size,
                    }
                    ck = save_checkpoint(model, output_dir, step, extras)
                    print(f"  [save] checkpoint → {ck}")
        # Final save.
        extras = {
            "step": step,
            "config": {
                "data": asdict(cfg.data),
                "model": asdict(cfg.model),
                "train": asdict(cfg.train),
            },
            "vocab_size": tokenizer.vocab_size,
        }
        save_checkpoint(model, output_dir, step, extras)
    finally:
        csv_fh.close()
