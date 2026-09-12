"""Self-supervised masked-language-model PRE-training loop.

The supervised trainer (train.py) learns BIO token classification from scratch — which the
small-encoder literature identifies as the root of mailwoman's two diagnosed pathologies
(overconfidence + format/delimiter over-reliance). This module adds the missing first phase: MLM
pre-training on the corpus TEXT (BIO labels ignored), producing an encoder checkpoint that a later
supervised run fine-tunes from via ``cfg.train.init_from``.

Everything but the objective is shared with the supervised loop: the same schedules, parameter
groups, batch preparation, checkpoint format and data loader. The only new model surface is
``MailwomanCoarseEncoder.forward_mlm``, a tied-embedding head that adds no parameters — so the
state dict this writes is key-identical to a supervised model's and loads through
``from_pretrained`` without special handling.

Mirrors the supervised loop's conventions: bf16 via explicit model cast (no autocast — the gfx1103
fast-path hang documented in train.py), AdamW, grad-clip, crash-and-resume via optimizer.pt /
scheduler.pt / training_state.json, Trackio mirror of metrics. Activated by
``cfg.train.objective == "mlm"`` (train.train() routes here); the CLI ``train`` subcommand is reused.
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Any

import torch
from torch.optim import AdamW

from ..config import Config
from ..data.loader import iter_batches
from ..data.masking import mask_tokens
from ..nn.encoder import build_model, force_math_sdpa, model_param_count
from ..observability.trackio import init_tracker
from ..optim.schedules import build_scheduler
from ..tokenizer import Tokenizer
from .batch import precision_to_dtype, to_tensor_batch
from .checkpoint import find_latest_checkpoint, save_checkpoint


@torch.no_grad()
def _mlm_eval(cfg: Config, model: Any, tokenizer: Tokenizer, device: Any, *, mask_token_id: int) -> dict[str, Any]:
    """MLM cross-entropy + perplexity over a bounded slice of the val split."""
    was_training = model.training
    model.eval()
    gen = torch.Generator().manual_seed(cfg.train.seed)
    total, n = 0.0, 0
    max_batches = max(1, cfg.train.eval_every_steps // 50)  # cheap, bounded
    for batch in iter_batches(cfg, tokenizer, split="val", batch_size=cfg.train.batch_size, seed=cfg.train.seed):
        tb = to_tensor_batch(batch, device)
        masked, labels = mask_tokens(
            tb["input_ids"].cpu(),
            tb["attention_mask"].cpu(),
            mask_prob=cfg.train.mlm_mask_prob,
            mask_token_id=mask_token_id,
            vocab_size=tokenizer.vocab_size,
            generator=gen,
        )
        out = model.forward_mlm(
            input_ids=masked.to(device), attention_mask=tb["attention_mask"], mlm_labels=labels.to(device)
        )
        if out.loss is not None:
            total += float(out.loss.item())
            n += 1
        if n >= max_batches:
            break
    if was_training:
        model.train()
    avg = total / max(1, n)
    return {"mlm_val_loss": avg, "mlm_val_perplexity": math.exp(min(20.0, avg))}


def load_pretrain_model(cfg: Config, tokenizer: Tokenizer, device: torch.device, resume_from: Path | None) -> Any:
    """The encoder to pre-train: restored from a checkpoint, or built fresh from the config."""
    if resume_from is not None:
        from ..nn.encoder import MailwomanCoarseEncoder

        print(f"[pretrain] resuming from {resume_from}")
        model = MailwomanCoarseEncoder.from_pretrained(resume_from)
    else:
        model = build_model(cfg, vocab_size=tokenizer.vocab_size, pad_token_id=tokenizer.pad_id)
    model.to(device)
    amp_dtype = precision_to_dtype(cfg.train.precision, device)
    if amp_dtype is not None and device.type == "cuda":
        model.to(dtype=amp_dtype)  # explicit cast, not autocast (gfx1103 hang — see train.py)
    return model


def restore_pretrain_state(optim: AdamW, scheduler: Any, resume_from: Path) -> int:
    """Restore the optimizer and schedule from a checkpoint, and return the step it stopped at.

    A checkpoint written before `scheduler.pt` existed carries the step and no schedule state, so
    the schedule is REPLAYED that many times rather than left at step 0. Left at 0 the run resumes
    inside warmup at a learning rate the earlier steps had already passed, which trains without
    complaint and does not reproduce the run it claims to continue.
    """
    resume_step = 0
    if (resume_from / "optimizer.pt").is_file():
        optim.load_state_dict(torch.load(resume_from / "optimizer.pt", weights_only=False))  # nosec B614 — resume loads state WE wrote under this output_dir
    if (resume_from / "training_state.json").is_file():
        resume_step = int(json.loads((resume_from / "training_state.json").read_text()).get("step", 0))
    if (resume_from / "scheduler.pt").is_file():
        scheduler.load_state_dict(torch.load(resume_from / "scheduler.pt", weights_only=False))  # nosec B614 — same trusted resume dir
    else:
        for _ in range(resume_step):
            scheduler.step()
    print(f"[pretrain] resumed at step={resume_step}")
    return resume_step


def run_pretrain_loop(
    cfg: Config,
    model: Any,
    tokenizer: Tokenizer,
    device: torch.device,
    *,
    optim: AdamW,
    scheduler: Any,
    tracker: Any,
    output_dir: Path,
    resume_step: int,
    mask_token_id: int,
) -> None:
    """Step the MLM objective to ``cfg.train.max_steps``, logging, evaluating and checkpointing.

    Each epoch re-opens the loader at ``seed + epoch``, which is the supervised loop's convention —
    the two must draw the same rows in the same order for a pre-trained checkpoint to be a fair
    starting point for a fine-tune.
    """
    gen = torch.Generator().manual_seed(cfg.train.seed)
    step = resume_step
    started = time.time()
    loss_running = 0.0
    log_every = max(1, cfg.train.log_every_steps)
    grad_clip = float(getattr(cfg.train, "grad_clip_norm", 1.0))

    def extras() -> dict[str, Any]:
        from dataclasses import asdict

        return {
            "step": step,
            "config": {"data": asdict(cfg.data), "model": asdict(cfg.model), "train": asdict(cfg.train)},
            "vocab_size": tokenizer.vocab_size,
        }

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
            tb = to_tensor_batch(batch, device)
            # Mask on CPU (cheap, keeps the RNG device-independent), then move to device.
            masked, labels = mask_tokens(
                tb["input_ids"].cpu(),
                tb["attention_mask"].cpu(),
                mask_prob=cfg.train.mlm_mask_prob,
                mask_token_id=mask_token_id,
                vocab_size=tokenizer.vocab_size,
                generator=gen,
            )
            optim.zero_grad(set_to_none=True)
            out = model.forward_mlm(
                input_ids=masked.to(device), attention_mask=tb["attention_mask"], mlm_labels=labels.to(device)
            )
            loss: Any = out.loss
            if loss is None:
                raise RuntimeError("forward_mlm returned no loss")
            loss.backward()
            if grad_clip > 0:
                torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=grad_clip)
            optim.step()
            scheduler.step()
            step += 1
            loss_running += float(loss.detach().cpu())

            if step % log_every == 0:
                avg = loss_running / log_every
                loss_running = 0.0
                lr = float(scheduler.get_last_lr()[0])
                ppl = math.exp(min(20.0, avg))
                elapsed = time.time() - started
                print(
                    f"[pretrain] step {step}/{cfg.train.max_steps} mlm_loss={avg:.4f} "
                    f"ppl={ppl:.1f} lr={lr:.6f} rate={step / elapsed:.2f}/s"
                )
                tracker.log(
                    {"mlm_train_loss": avg, "mlm_train_perplexity": ppl, "lr": lr, "wall_seconds": elapsed},
                    step=step,
                )

            if step % cfg.train.eval_every_steps == 0:
                metrics = _mlm_eval(cfg, model, tokenizer, device, mask_token_id=mask_token_id)
                print(f"[pretrain]   [eval] {metrics}")
                tracker.log(metrics, step=step)

            if step % cfg.train.save_every_steps == 0:
                save_checkpoint(model, output_dir, step, extras(), optim=optim, scheduler=scheduler)
                print(f"[pretrain]   [save] checkpoint @ step {step}")
    save_checkpoint(model, output_dir, step, extras(), optim=optim, scheduler=scheduler)
    print(f"[pretrain] done @ step {step} -> {output_dir}")


def pretrain(cfg: Config, *, resume_from: str | Path | None = None) -> None:
    """Run MLM pre-training; write encoder checkpoints to ``cfg.train.output_dir``."""
    if cfg.train.objective != "mlm":
        raise ValueError(f"pretrain() needs objective='mlm', got {cfg.train.objective!r}")
    force_math_sdpa()
    output_dir = Path(cfg.train.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if resume_from == "auto":
        resume_from = find_latest_checkpoint(output_dir)
    resume_path = Path(resume_from) if resume_from is not None else None

    tokenizer = Tokenizer(Path(cfg.data.tokenizer_dir) / "tokenizer.model")
    mask_token_id = tokenizer.unk_id  # SentencePiece has no [MASK]; reuse <unk> (see masking.py)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    model = load_pretrain_model(cfg, tokenizer, device, resume_path)
    print(
        f"[pretrain] device={device} params={model_param_count(model):,} "
        f"objective=mlm mask_prob={cfg.train.mlm_mask_prob} mask_token_id={mask_token_id}"
    )

    optim = AdamW(model.parameters(), lr=cfg.train.learning_rate, weight_decay=cfg.train.weight_decay)
    scheduler = build_scheduler(optim, cfg.train)
    resume_step = restore_pretrain_state(optim, scheduler, resume_path) if resume_path is not None else 0

    tracker = init_tracker(cfg)
    try:
        run_pretrain_loop(
            cfg,
            model,
            tokenizer,
            device,
            optim=optim,
            scheduler=scheduler,
            tracker=tracker,
            output_dir=output_dir,
            resume_step=resume_step,
            mask_token_id=mask_token_id,
        )
    finally:
        tracker.finish()
