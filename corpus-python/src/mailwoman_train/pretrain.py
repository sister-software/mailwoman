"""Self-supervised masked-language-model PRE-training loop.

The supervised trainer (train.py) learns BIO token classification from scratch — which the
small-encoder literature identifies as the root of mailwoman's two diagnosed pathologies
(overconfidence + format/delimiter over-reliance). This module adds the missing first phase: MLM
pre-training on the corpus TEXT (BIO labels ignored), producing an encoder checkpoint that a later
supervised run fine-tunes from via ``cfg.train.init_from``.

Reuse-heavy by design: it borrows train.py's helpers (``_build_scheduler``, ``_precision_to_dtype``,
``_to_tensor_batch``, ``save_checkpoint``, ``find_latest_checkpoint``, ``force_math_sdpa``,
``model_param_count``), data_loader's ``iter_batches``, masking.py's BERT 80/10/10 masking, and
trackio_logging's tracker. The only new model surface is ``MailwomanCoarseEncoder.forward_mlm`` (a
tied-embedding head, no new params -> the saved state_dict is key-identical to a supervised model's
and loads via ``from_pretrained``).

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

import torch
from torch.optim import AdamW

from .config import Config
from .data_loader import iter_batches
from .masking import mask_tokens
from .model import build_model, force_math_sdpa, model_param_count
from .tokenizer import Tokenizer
from .train import (
    _build_scheduler,
    _precision_to_dtype,
    _to_tensor_batch,
    find_latest_checkpoint,
    save_checkpoint,
)
from .trackio_logging import init_tracker


@torch.no_grad()
def _mlm_eval(cfg: Config, model, tokenizer: Tokenizer, device, *, mask_token_id: int) -> dict:
    """MLM cross-entropy + perplexity over a bounded slice of the val split."""
    was_training = model.training
    model.eval()
    gen = torch.Generator().manual_seed(cfg.train.seed)
    total, n = 0.0, 0
    max_batches = max(1, cfg.train.eval_every_steps // 50)  # cheap, bounded
    for batch in iter_batches(
        cfg, tokenizer, split="val", batch_size=cfg.train.batch_size, seed=cfg.train.seed
    ):
        tb = _to_tensor_batch(batch, device)
        masked, labels = mask_tokens(
            tb["input_ids"].cpu(), tb["attention_mask"].cpu(),
            mask_prob=cfg.train.mlm_mask_prob, mask_token_id=mask_token_id,
            vocab_size=tokenizer.vocab_size, generator=gen,
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


def pretrain(cfg: Config, *, resume_from: str | Path | None = None) -> None:
    """Run MLM pre-training; write encoder checkpoints to ``cfg.train.output_dir``."""
    assert cfg.train.objective == "mlm", f"pretrain() needs objective='mlm', got {cfg.train.objective!r}"
    force_math_sdpa()
    output_dir = Path(cfg.train.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if resume_from == "auto":
        resume_from = find_latest_checkpoint(output_dir)

    tokenizer = Tokenizer(Path(cfg.data.tokenizer_dir) / "tokenizer.model")
    mask_token_id = tokenizer.unk_id  # SentencePiece has no [MASK]; reuse <unk> (see masking.py)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    if resume_from is not None:
        from .model import MailwomanCoarseEncoder

        print(f"[pretrain] resuming from {resume_from}")
        model = MailwomanCoarseEncoder.from_pretrained(resume_from)
    else:
        model = build_model(cfg, vocab_size=tokenizer.vocab_size, pad_token_id=tokenizer.pad_id)
    model.to(device)

    amp_dtype = _precision_to_dtype(cfg.train.precision, device)
    if amp_dtype is not None and device.type == "cuda":
        model.to(dtype=amp_dtype)  # explicit cast, not autocast (gfx1103 hang — see train.py)

    print(f"[pretrain] device={device} params={model_param_count(model):,} "
          f"objective=mlm mask_prob={cfg.train.mlm_mask_prob} mask_token_id={mask_token_id}")

    optim = AdamW(model.parameters(), lr=cfg.train.learning_rate, weight_decay=cfg.train.weight_decay)
    scheduler = _build_scheduler(optim, cfg.train)

    resume_step = 0
    if resume_from is not None:
        rp = Path(resume_from)
        if (rp / "optimizer.pt").is_file():
            optim.load_state_dict(torch.load(rp / "optimizer.pt", weights_only=False))
        if (rp / "training_state.json").is_file():
            resume_step = int(json.loads((rp / "training_state.json").read_text()).get("step", 0))
        if (rp / "scheduler.pt").is_file():
            scheduler.load_state_dict(torch.load(rp / "scheduler.pt", weights_only=False))
        else:
            for _ in range(resume_step):
                scheduler.step()
        print(f"[pretrain] resumed at step={resume_step}")

    tracker = init_tracker(cfg)
    gen = torch.Generator().manual_seed(cfg.train.seed)
    step = resume_step
    started = time.time()
    loss_running = 0.0
    log_every = max(1, cfg.train.log_every_steps)
    grad_clip = float(getattr(cfg.train, "grad_clip_norm", 1.0))

    def extras() -> dict:
        from dataclasses import asdict

        return {
            "step": step,
            "config": {"data": asdict(cfg.data), "model": asdict(cfg.model), "train": asdict(cfg.train)},
            "vocab_size": tokenizer.vocab_size,
        }

    try:
        epoch = 0
        while step < cfg.train.max_steps:
            epoch += 1
            for batch in iter_batches(
                cfg, tokenizer, split="train", batch_size=cfg.train.batch_size,
                seed=cfg.train.seed + epoch, row_limit=cfg.data.train_rows_per_epoch,
            ):
                if step >= cfg.train.max_steps:
                    break
                model.train()
                tb = _to_tensor_batch(batch, device)
                # Mask on CPU (cheap, keeps the RNG device-independent), then move to device.
                masked, labels = mask_tokens(
                    tb["input_ids"].cpu(), tb["attention_mask"].cpu(),
                    mask_prob=cfg.train.mlm_mask_prob, mask_token_id=mask_token_id,
                    vocab_size=tokenizer.vocab_size, generator=gen,
                )
                optim.zero_grad(set_to_none=True)
                out = model.forward_mlm(
                    input_ids=masked.to(device), attention_mask=tb["attention_mask"], mlm_labels=labels.to(device)
                )
                loss = out.loss
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
                    print(f"[pretrain] step {step}/{cfg.train.max_steps} mlm_loss={avg:.4f} "
                          f"ppl={ppl:.1f} lr={lr:.6f} rate={step/elapsed:.2f}/s")
                    tracker.log({"mlm_train_loss": avg, "mlm_train_perplexity": ppl, "lr": lr,
                                 "wall_seconds": elapsed}, step=step)

                if step % cfg.train.eval_every_steps == 0:
                    metrics = _mlm_eval(cfg, model, tokenizer, device, mask_token_id=mask_token_id)
                    print(f"[pretrain]   [eval] {metrics}")
                    tracker.log(metrics, step=step)

                if step % cfg.train.save_every_steps == 0:
                    save_checkpoint(model, output_dir, step, extras(), optim=optim, scheduler=scheduler)
                    print(f"[pretrain]   [save] checkpoint @ step {step}")
        save_checkpoint(model, output_dir, step, extras(), optim=optim, scheduler=scheduler)
        print(f"[pretrain] done @ step {step} -> {output_dir}")
    finally:
        tracker.finish()
