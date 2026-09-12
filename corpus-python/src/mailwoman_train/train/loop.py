"""The optimizer loop: batches in, steps taken, callbacks notified.

Two things stay in the loop rather than moving to a callback, and both are here because the loop
owns state a callback only sees the end of. The running train loss accumulates across the window a
callback reports, so resetting it is what closes that window. Evaluating costs a forward pass over
the val split, so the loop decides WHEN it happens and the callbacks only observe the result.

`step` counts OPTIMIZER steps, not micro-batches, so it lines up with `cfg.train.max_steps`
whatever `grad_accum_steps` is.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import torch

from ..config import Config
from ..data.loader import iter_batches
from ..protocols import TrainCallback
from .batch import to_tensor_batch
from .callbacks.checkpointer import checkpoint_extras
from .checkpoint import save_checkpoint
from .noise import perturb_anchor_confidence, perturb_evidence_noise, perturb_gazetteer_confidence
from .setup import Precision, Regularizers
from .state import TrainState


def apply_curricula(cfg: Config, tb: dict[str, Any], step: int) -> None:
    """Perturb the evidence channels in place, by optimizer step.

    Every curriculum here ramps with the run so the model cannot launder a clue: it must keep label
    competence WITH and WITHOUT each channel. Each is conditioned on its own config flag so a run
    that leaves one off draws nothing for it and stays reproducible against the runs before it.
    """
    # Postcode-anchor confidence curriculum (#239/#240): perturb by optimizer step so the
    # model can't launder the anchor (no-op until 25% of max_steps).
    if "anchor_confidence" in tb:
        tb["anchor_confidence"] = perturb_anchor_confidence(tb["anchor_confidence"], step, cfg.train.max_steps)
    # Gazetteer-anchor confidence curriculum (#464, v0.9.13): same ramped per-row zero-out
    # so the model keeps label competence with AND without the clue (recovers the v0.9.12
    # US postcode -3.7). Conditioned on the config flag so always-on runs stay reproducible.
    if "gazetteer_confidence" in tb and getattr(cfg.train, "gazetteer_curriculum", False):
        tb["gazetteer_confidence"] = perturb_gazetteer_confidence(tb["gazetteer_confidence"], step, cfg.train.max_steps)
    # Evidence-bundle anti-over-trust curriculum (v3.16.0): the SAME ramped per-row
    # zero-out applied to both bundle channels — the P-A decay showed a fresh evidence
    # channel over-trusts without it. Per-channel independent draws, so the model also
    # sees each channel alone (the bundle must inform, never become a joint crutch).
    if getattr(cfg.train, "evidence_curriculum", False):
        # False-evidence noise FIRST (v3.21.0, see perturb_evidence_noise) — then the
        # absence zero-out draws over the noised batch; the rates compose independently.
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
    """The checkpoint a finished run owes, and the Fisher artifact that lands beside it.

    This save stays with the loop rather than moving to the checkpointer callback: a run that
    reached its last step owes a checkpoint whether or not a callback is listening, and the Fisher
    artifact is written into the directory this call returns.
    """
    final_ck = save_checkpoint(
        state.model,
        output_dir,
        step,
        checkpoint_extras(state, step),
        optim=state.optimizer,
        scheduler=state.scheduler,
    )
    # Fisher artifact lands BESIDE the final checkpoint (the weights-bundle contract: versioned
    # filename + provenance sidecar, the lexicon discipline). Zero-count capture (a run shorter
    # than its window says it was armed for) raises in finalize — loud, never a silent absence.
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

    `evaluate` is the val pass the loop calls on its own schedule; it is passed in rather than
    imported so this module does not depend on the metric stack it never reads.
    """
    model, optim, scheduler = state.model, state.optimizer, state.scheduler
    device, output_dir = state.device, state.output_dir
    accum = precision.accum
    step = resume_step
    micro_step = 0
    train_loss_running = 0.0
    log_every = max(1, cfg.train.log_every_steps)
    print(f"max_steps={cfg.train.max_steps} batch_size={cfg.train.batch_size}")

    # The streaming iterator may exhaust before max_steps if row_limit is set;
    # restart per "epoch" until step budget is met.
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
        ):
            if step >= cfg.train.max_steps:
                break
            model.train()
            tb = to_tensor_batch(batch, device)
            apply_curricula(cfg, tb, step)
            # Optimizer step happens every ``accum`` micro-batches; gradients accumulate
            # across the micro-batches in between. ``step`` counts *optimizer* steps,
            # not micro-steps, so it lines up with the cfg.train.max_steps budget.
            is_accum_boundary = ((micro_step + 1) % accum) == 0
            if micro_step % accum == 0:
                optim.zero_grad(set_to_none=True)
            if precision.use_amp_autocast:
                with torch.autocast(device_type=device.type, dtype=precision.amp_dtype):
                    out = model(**tb)
            else:
                out = model(**tb)
            # EWC brake (fine-tunes only): the quadratic penalty rides the loss INSIDE the
            # accum division so effective-batch scaling matches the data loss.
            ewc = regularizers.ewc
            loss_total = out.loss if ewc is None else out.loss + ewc.penalty(model)
            loss = loss_total / accum
            loss.backward()
            micro_step += 1
            if not is_accum_boundary:
                continue
            # Fisher capture window (base runs): read the accumulated gradient BEFORE clipping
            # (the empirical Fisher is defined on ∂L/∂θ; the clipped surrogate understates
            # curvature exactly where it is largest). Read-only — trajectory unaffected.
            if (
                regularizers.fisher_acc is not None
                and regularizers.fisher_window_start is not None
                and step >= regularizers.fisher_window_start
            ):
                regularizers.fisher_acc.accumulate(model)
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

            # The running sum is the loop's, not a callback's: it accumulates across the window
            # a callback only sees the end of, and resetting it is what closes that window.
            if step % log_every == 0:
                state.train_loss = train_loss_running / log_every
                train_loss_running = 0.0
            state.learning_rate = float(scheduler.get_last_lr()[0])
            state.elapsed = time.time() - state.started
            for callback in callbacks:
                callback.on_step_end(state, step)

            # Evaluating costs a forward pass over the val split, so the loop decides when it
            # happens; the callbacks only observe the result.
            if step % cfg.train.eval_every_steps == 0:
                state.val = evaluate(cfg, state.tokenizer, model, device, max_rows=cfg.data.val_rows)
                state.elapsed = time.time() - state.started
                for callback in callbacks:
                    callback.on_eval_end(state, step, state.val)

    write_final_artifacts(state, step, output_dir, regularizers, cfg)
