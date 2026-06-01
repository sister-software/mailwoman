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
from .labels import ACTIVE_BIO_LABELS, ACTIVE_TAGS
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


def _constant_with_warmup(optimizer: AdamW, warmup_steps: int) -> LambdaLR:
    # Linear warmup → constant. The verdict-smoke mode per v0.5.0 (see
    # docs/articles/plan/reference/VERDICT_SMOKES.md): cosine decay over a short window
    # collapses the LR before divergence shows in the loss curve.
    def lr_lambda(step: int) -> float:
        if step < warmup_steps:
            return float(step) / float(max(1, warmup_steps))
        return 1.0

    return LambdaLR(optimizer, lr_lambda)


def _build_scheduler(optim: AdamW, cfg_train) -> LambdaLR:
    schedule = getattr(cfg_train, "lr_schedule", "cosine")
    if schedule == "constant":
        return _constant_with_warmup(optim, cfg_train.warmup_steps)
    if schedule == "cosine":
        return _cosine_with_warmup(optim, cfg_train.warmup_steps, cfg_train.max_steps)
    raise ValueError(
        f"unknown train.lr_schedule={schedule!r}; expected 'cosine' or 'constant'"
    )


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
    """Compute macro/per-class token-level F1 over a batch. Ignores ``IGNORE_INDEX`` positions.

    Returns ``macro_f1`` plus per-BIO-label F1 (``f1.B-locality``, ``f1.I-locality``, …),
    collapsed per-tag F1 (``f1_tag.locality``, …) computed as (B + I) / 2, AND per-tag support
    (``support_tag.locality`` = # true B+I instances in the val sample). The per-tag F1 + support
    columns are what the CSV log / dashboard write; the per-BIO columns are for fine-grained
    debugging. ``macro_f1`` averages only component labels (excludes "O") that have support > 0,
    so a tag absent from the val sample doesn't drag it down (see the support-aware comment below).
    """
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
    support = tp + fn  # number of true instances of each label in the val set
    precision = tp / (tp + fp + 1e-9)
    recall = tp / (tp + fn + 1e-9)
    f1 = 2 * precision * recall / (precision + recall + 1e-9)
    per_label = {ACTIVE_BIO_LABELS[c]: float(f1[c]) for c in range(num_labels)}
    per_label_support = {ACTIVE_BIO_LABELS[c]: int(support[c]) for c in range(num_labels)}

    # Support-aware macro: average F1 only over COMPONENT labels (exclude "O") that actually
    # occur in the val sample. A zero-support label (a tag the val sample happens not to contain —
    # e.g. po_box/cedex in a US-primary sample) otherwise pins F1 at 0 and drags the macro down;
    # that's a val-coverage artifact, not model quality. Excluding "O" also stops its huge-support,
    # ~1.0 F1 from inflating the average. See val-set stratification (Layer 2) for the coverage fix.
    supported = [c for c in range(num_labels) if ACTIVE_BIO_LABELS[c] != "O" and support[c] > 0]
    macro = sum(float(f1[c]) for c in supported) / len(supported) if supported else 0.0

    result = {"macro_f1": macro, **{f"f1.{k}": v for k, v in per_label.items()}}
    for tag in ACTIVE_TAGS:
        b_f1 = per_label.get(f"B-{tag}", 0.0)
        i_f1 = per_label.get(f"I-{tag}", 0.0)
        result[f"f1_tag.{tag}"] = (b_f1 + i_f1) / 2.0
        # Per-tag support (B + I true instances). 0 ⇒ the tag is absent from the val sample, so its
        # F1 is undefined — callers log it as a gap rather than a misleading flat-zero.
        result[f"support_tag.{tag}"] = per_label_support.get(f"B-{tag}", 0) + per_label_support.get(f"I-{tag}", 0)
    return result


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
    metrics = _token_f1(preds, labels, num_labels=len(ACTIVE_BIO_LABELS))
    metrics["val_loss"] = loss_total / seen_batches
    metrics["val_rows"] = rows_seen
    return metrics


def save_checkpoint(
    model: torch.nn.Module,
    output_dir: Path,
    step: int,
    extras: dict,
    *,
    optim: torch.optim.Optimizer | None = None,
    scheduler: torch.optim.lr_scheduler._LRScheduler | None = None,
    rng_state: dict | None = None,
) -> Path:
    """Save model + optimizer + scheduler + RNG state into ``output_dir/step-XXXXX/``.

    Full resume capability — gfx1103 has firmware GPU hangs under sustained load, so a
    crash-and-resume loop is expected. The latest checkpoint contains everything needed to
    pick up exactly where the previous run left off (modulo data-loader position, which is
    re-seeded per-epoch on resume).
    """
    ck = output_dir / f"step-{step:06d}"
    ck.mkdir(parents=True, exist_ok=True)
    if hasattr(model, "save_pretrained"):
        model.save_pretrained(ck)  # type: ignore[arg-type]
    else:
        torch.save(model.state_dict(), ck / "pytorch_model.bin")
    if optim is not None:
        torch.save(optim.state_dict(), ck / "optimizer.pt")
    if scheduler is not None:
        torch.save(scheduler.state_dict(), ck / "scheduler.pt")
    if rng_state is not None:
        torch.save(rng_state, ck / "rng_state.pt")
    (ck / "training_state.json").write_text(json.dumps(extras, indent=2) + "\n", encoding="utf-8")
    return ck


def find_latest_checkpoint(output_dir: Path) -> Path | None:
    """Return the highest-step ``step-XXXXXX`` checkpoint dir under ``output_dir``, or None."""
    if not output_dir.is_dir():
        return None
    candidates = sorted(output_dir.glob("step-*"))
    return candidates[-1] if candidates else None


def train(cfg: Config, *, resume_from: str | Path | None = None) -> None:
    _set_seed(cfg.train.seed)
    # MLM pre-training is a different objective + loop; route there (lazy import avoids a
    # train<->pretrain module cycle). pretrain() writes from_pretrained-loadable checkpoints.
    if getattr(cfg.train, "objective", "supervised") == "mlm":
        from .pretrain import pretrain

        pretrain(cfg, resume_from=resume_from)
        return
    # Mandatory on gfx1103 — flash/mem-efficient SDPA paths crash bf16 on this GPU.
    force_math_sdpa()
    output_dir = Path(cfg.train.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Auto-detect latest checkpoint when resume_from == "auto" — convenient for restart-on-hang.
    if resume_from == "auto":
        latest = find_latest_checkpoint(output_dir)
        resume_from = latest

    tokenizer = Tokenizer(Path(cfg.data.tokenizer_dir) / "tokenizer.model")
    verify_tokenizer_alignment(Path(cfg.data.corpus_dir), tokenizer)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if resume_from is not None:
        # Use the checkpoint's saved model rather than a fresh from-scratch init.
        from .model import MailwomanCoarseEncoder

        print(f"resuming from {resume_from}")
        model = MailwomanCoarseEncoder.from_pretrained(resume_from)
    else:
        model = build_model(cfg, vocab_size=tokenizer.vocab_size, pad_token_id=tokenizer.pad_id)
        # Fine-tune from a pre-trained encoder: load MODEL weights only (no optimizer/scheduler/
        # step, unlike resume), so the supervised run starts fresh on the MLM-pretrained encoder.
        # The pretrain checkpoint's state_dict is key-identical (tied MLM head adds no params), so
        # this loads cleanly; strict=False surfaces any head mismatch instead of raising.
        init_from = getattr(cfg.train, "init_from", "")
        if init_from:
            sd = torch.load(Path(init_from) / "pytorch_model.bin", map_location="cpu", weights_only=True)
            missing, unexpected = model.load_state_dict(sd, strict=False)
            print(f"[init_from] loaded encoder from {init_from} (missing={len(missing)} unexpected={len(unexpected)})")
    model.to(device)

    print(f"device={device} param_count={model_param_count(model):,}")
    print(f"gpu={torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'cpu-only'}")

    optim = AdamW(
        model.parameters(),
        lr=cfg.train.learning_rate,
        weight_decay=cfg.train.weight_decay,
    )
    scheduler = _build_scheduler(optim, cfg.train)
    print(f"lr_schedule={getattr(cfg.train, 'lr_schedule', 'cosine')}")
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

    # Resume — load optimizer/scheduler/step.
    resume_step = 0
    if resume_from is not None:
        resume_from_path = Path(resume_from)
        opt_p = resume_from_path / "optimizer.pt"
        if opt_p.is_file():
            optim.load_state_dict(torch.load(opt_p, weights_only=False))
        ts_p = resume_from_path / "training_state.json"
        if ts_p.is_file():
            ts = json.loads(ts_p.read_text(encoding="utf-8"))
            resume_step = int(ts.get("step", 0))
        sched_p = resume_from_path / "scheduler.pt"
        if sched_p.is_file():
            scheduler.load_state_dict(torch.load(sched_p, weights_only=False))
        else:
            # Pre-resume-feature checkpoint: scheduler.pt didn't exist. Fast-forward the
            # scheduler so LR is correct for the resumed step. ``scheduler.step()`` is cheap.
            for _ in range(resume_step):
                scheduler.step()
        print(f"resumed at step={resume_step}")

    csv_path = csv_log_path(cfg)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    # On resume, append to the existing CSV instead of clobbering.
    csv_mode = "a" if resume_step > 0 and csv_path.is_file() else "w"
    csv_fh = csv_path.open(csv_mode, encoding="utf-8", newline="")
    csv_writer = csv.writer(csv_fh)
    per_tag_cols = [f"f1.{tag}" for tag in ACTIVE_TAGS]
    if csv_mode == "w":
        csv_writer.writerow(
            [
                "step",
                "wall_seconds",
                "train_loss",
                "lr",
                "val_loss",
                "val_macro_f1",
                *per_tag_cols,
            ]
        )

    # Optional Trackio mirror of the CSV metrics (no-op unless cfg.train.trackio_enabled).
    # Defined before the try/ below so the finally block can always call tracker.finish().
    from .trackio_logging import init_tracker

    tracker = init_tracker(cfg)

    step = resume_step
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
                # Stage 2 ships CE + CRF NLL — the CRF leg can produce sharp gradients
                # during warmup, especially under bf16. Clip global norm to 1.0 before
                # stepping. The v0.2.0 (CE-only) Stage 1 run trained stably to 50k steps
                # without clipping, but adding the CRF + label smoothing duo without a
                # gradient guard diverged at step 1000 when warmup LR (5e-4) peaked.
                grad_clip = float(getattr(cfg.train, "grad_clip_norm", 1.0))
                if grad_clip > 0:
                    torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=grad_clip)
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
                    csv_writer.writerow([step, f"{elapsed:.1f}", f"{avg:.6f}", f"{lr:.8f}", "", ""] + [""] * len(per_tag_cols))
                    csv_fh.flush()
                    tracker.log({"train_loss": avg, "lr": lr, "wall_seconds": elapsed}, step=step)

                if step % cfg.train.eval_every_steps == 0:
                    val = _eval_val(cfg, tokenizer, model, device, max_rows=cfg.data.val_rows)
                    tag_summary = "  ".join(
                        f"{t}={val.get(f'f1_tag.{t}', 0.0):.3f}" for t in ("locality", "region", "street", "house_number", "postcode")
                    )
                    print(
                        f"  [eval] val_loss={val.get('val_loss', float('nan')):.4f}"
                        f"  macro_f1={val.get('macro_f1', 0.0):.4f}"
                        f"  val_rows={val.get('val_rows', 0)}"
                        f"\n         {tag_summary}"
                    )
                    elapsed = time.time() - started
                    # CSV: per-tag F1, but a blank cell ("") for tags with no val support so readers
                    # see NaN rather than a misleading 0.0.
                    tag_f1_values = [
                        (f"{val.get(f'f1_tag.{tag}', 0.0):.6f}" if int(val.get(f"support_tag.{tag}", 0)) > 0 else "")
                        for tag in ACTIVE_TAGS
                    ]
                    csv_writer.writerow(
                        [
                            step,
                            f"{elapsed:.1f}",
                            "",
                            "",
                            f"{val.get('val_loss', float('nan')):.6f}",
                            f"{val.get('macro_f1', 0.0):.6f}",
                            *tag_f1_values,
                        ]
                    )
                    csv_fh.flush()
                    eval_metrics: dict[str, float] = {
                        "val_loss": float(val.get("val_loss", float("nan"))),
                        "val_macro_f1": float(val.get("macro_f1", 0.0)),
                        "wall_seconds": elapsed,
                    }
                    # Log per-tag support alongside F1. A blank/missing `f1.<tag>` chart is then
                    # self-explaining: `support.<tag>` = 0 means the val sample contains no examples
                    # of that tag (a coverage gap — see Layer 2), NOT that the model scored zero. We
                    # OMIT `f1.<tag>` when support is 0 so the dashboard draws a gap, not a flat-zero
                    # line that reads as a model failure.
                    tags_with_support = 0
                    for tag in ACTIVE_TAGS:
                        sup = int(val.get(f"support_tag.{tag}", 0))
                        eval_metrics[f"support.{tag}"] = sup
                        if sup > 0:
                            eval_metrics[f"f1.{tag}"] = float(val.get(f"f1_tag.{tag}", 0.0))
                            tags_with_support += 1
                    eval_metrics["val_tags_with_support"] = tags_with_support
                    tracker.log(eval_metrics, step=step)

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
                    ck = save_checkpoint(
                        model, output_dir, step, extras, optim=optim, scheduler=scheduler
                    )
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
        save_checkpoint(model, output_dir, step, extras, optim=optim, scheduler=scheduler)
    finally:
        csv_fh.close()
        tracker.finish()
