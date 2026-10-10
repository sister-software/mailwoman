"""The optimizer loop: batches in, steps taken, callbacks notified.

`step` counts OPTIMIZER steps rather than micro-batches, so it lines up with `cfg.train.max_steps`
whatever `grad_accum_steps` is.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import torch

from ..config import Config
from ..data.loader import iter_batches
from ..exposure.report import StageCounter, build_report
from ..protocols import TrainCallback
from ..semantic_tags import label_set_contract
from .batch import to_tensor_batch
from .callbacks.checkpointer import checkpoint_extras
from .checkpoint import save_checkpoint
from .noise import perturb_anchor_confidence, perturb_evidence_noise, perturb_gazetteer_confidence
from .setup import Precision, Regularizers
from .state import TrainState


def apply_curricula(cfg: Config, tb: dict[str, Any], step: int) -> None:
    """Perturb the evidence channels in place, by optimizer step.

    Each curriculum ramps with the run so the model cannot launder a clue. It is also conditioned
    on its own config flag, so a run that leaves one off stays reproducible against earlier runs.
    """
    if "anchor_confidence" in tb:
        tb["anchor_confidence"] = perturb_anchor_confidence(tb["anchor_confidence"], step, cfg.train.max_steps)
    if "gazetteer_confidence" in tb and getattr(cfg.train, "gazetteer_curriculum", False):
        tb["gazetteer_confidence"] = perturb_gazetteer_confidence(tb["gazetteer_confidence"], step, cfg.train.max_steps)
    # Per-channel independent draws, so the model also sees each channel separately.
    if getattr(cfg.train, "evidence_curriculum", False):
        # False-evidence noise is drawn first. The absence zero-out then draws over the noised
        # batch.
        noise_p = float(getattr(cfg.train, "evidence_noise_prob", 0.0))
        if noise_p > 0.0:
            for prefix in ("street_type", "locality_surface"):
                fk, ck = f"{prefix}_features", f"{prefix}_confidence"
                if fk in tb and ck in tb:
                    tb[fk], tb[ck] = perturb_evidence_noise(tb[fk], tb[ck], step, cfg.train.max_steps, noise_p)
        for key in ("street_type_confidence", "locality_surface_confidence"):
            if key in tb:
                tb[key] = perturb_gazetteer_confidence(tb[key], step, cfg.train.max_steps)


def write_final_artifacts(
    state: TrainState, step: int, output_dir: Path, regularizers: Regularizers, cfg: Config
) -> None:
    """Write the final checkpoint and the Fisher artifact beside it.

    The save stays with the loop rather than a callback because a run that reached its last step
    owes a checkpoint whether or not a callback is listening.
    """
    final_ck = save_checkpoint(
        state.model,
        output_dir,
        step,
        checkpoint_extras(state, step),
        optim=state.optimizer,
        scheduler=state.scheduler,
    )
    # Fisher artifact lands beside the final checkpoint as a versioned filename plus provenance
    # sidecar. A zero-count capture raises in finalize rather than shipping a silent absence.
    if regularizers.fisher_acc is not None:
        fisher_path = regularizers.fisher_acc.save(
            final_ck,
            meta={
                "captured_at_step": step,
                "window_last_n_steps": int(getattr(cfg.train, "fisher_capture_last_n_steps", 2000)),
                "corpus_dir": cfg.data.corpus_dir,
                "seed": cfg.train.seed,
                "output_dir": str(output_dir),
            },
        )
        print(f"[fisher] artifact → {fisher_path} ({regularizers.fisher_acc.count} batches)")


def run_training_loop(
    cfg: Config,
    state: TrainState,
    callbacks: list[TrainCallback],
    *,
    resume_step: int,
    precision: Precision,
    regularizers: Regularizers,
    evaluate: Any,
) -> None:
    """Step until the budget is met, then write the final artifacts.

    `evaluate` is passed in rather than imported so this module does not depend on the metric
    stack it never reads.
    """
    model, optim, scheduler = state.model, state.optimizer, state.scheduler
    device, output_dir = state.device, state.output_dir
    accum = precision.accum
    step = resume_step
    state.start_step = resume_step
    micro_step = 0
    train_loss_running = 0.0
    log_every = max(1, cfg.train.log_every_steps)
    print(f"max_steps={cfg.train.max_steps} batch_size={cfg.train.batch_size}")
    # Every train row a consumed batch held, counted by jurisdiction and phenomenon: the realized
    # exposure the release check reads. A resumed process counts only what it trains, and writes its
    # own segment, taken from the step it resumed from, so a preempted run's segments sum.
    realized = StageCounter("realized_draws")

    # The streaming iterator may exhaust before max_steps when row_limit is set, so restart per
    # epoch.
    epoch = 0
    while step < cfg.train.max_steps:
        epoch += 1
        for batch in iter_batches(
            cfg,
            state.tokenizer,
            split="train",
            batch_size=cfg.train.batch_size,
            seed=cfg.train.seed + epoch,
            row_limit=cfg.data.train_rows_per_epoch,
            observer=realized.add_span_row,
        ):
            if step >= cfg.train.max_steps:
                break
            model.train()
            tb = to_tensor_batch(batch, device)
            apply_curricula(cfg, tb, step)
            is_accum_boundary = ((micro_step + 1) % accum) == 0
            if micro_step % accum == 0:
                optim.zero_grad(set_to_none=True)
            if precision.use_amp_autocast:
                with torch.autocast(device_type=device.type, dtype=precision.amp_dtype):
                    out = model(**tb)
            else:
                out = model(**tb)
            # EWC penalty is added to the loss inside the accumulation division so effective-batch scaling
            # matches the data loss.
            ewc = regularizers.ewc
            loss_total = out.loss if ewc is None else out.loss + ewc.penalty(model)
            loss = loss_total / accum
            loss.backward()
            micro_step += 1
            if not is_accum_boundary:
                continue
            # Fisher capture reads the accumulated gradient before clipping. The empirical
            # Fisher uses the unclipped ∂L/∂θ. Gradient clipping understates curvature
            # exactly where it is largest. Read-only.
            if (
                regularizers.fisher_acc is not None
                and regularizers.fisher_window_start is not None
                and step >= regularizers.fisher_window_start
            ):
                regularizers.fisher_acc.accumulate(model)
            # Clip the global norm before stepping: the CRF leg can produce sharp gradients
            # during warmup, especially under bf16.
            grad_clip = float(getattr(cfg.train, "grad_clip_norm", 1.0))
            if grad_clip > 0:
                torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=grad_clip)
            optim.step()
            scheduler.step()
            step += 1
            train_loss_running += float(loss.detach().cpu()) * accum

            if step % log_every == 0:
                state.train_loss = train_loss_running / log_every
                train_loss_running = 0.0
            state.learning_rate = float(scheduler.get_last_lr()[0])
            state.elapsed = time.time() - state.started
            for callback in callbacks:
                callback.on_step_end(state, step)

            if step % cfg.train.eval_every_steps == 0:
                state.val = evaluate(cfg, state.tokenizer, model, device, max_rows=cfg.data.val_rows)
                state.elapsed = time.time() - state.started
                for callback in callbacks:
                    callback.on_eval_end(state, step, state.val)

    write_final_artifacts(state, step, output_dir, regularizers, cfg)
    write_realized_exposure(realized, output_dir, cfg, resume_step=resume_step, final_step=step)


def write_realized_exposure(
    realized: StageCounter, output_dir: Path, cfg: Config, *, resume_step: int, final_step: int
) -> Path:
    """Write the realized-draws stage beside the checkpoint, as ``exposure-realized-from-<step>.json``."""
    report = build_report(
        [realized],
        # `Config` has no path to the YAML it was loaded from, so the run is identified by its
        # output directory and `training_config` stays null rather than a guess.
        label_set=label_set_contract(getattr(cfg.data, "label_set", "stage3")),
        inputs={
            "output_dir": str(output_dir),
            "corpus_dir": str(cfg.data.corpus_dir),
            "counted_from_step": str(resume_step),
            "counted_to_step": str(final_step),
        },
    )
    path = output_dir / f"exposure-realized-from-{resume_step}.json"
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[exposure] realized draws → {path}")
    return path
