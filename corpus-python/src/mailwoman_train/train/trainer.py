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

import json
import random
import time
from dataclasses import asdict
from pathlib import Path

import torch

from ..config import Config
from ..data.dose import format_derivation, resolve_config_doses
from ..data.loader import IGNORE_INDEX, iter_batches, verify_tokenizer_alignment
from ..evaluation.metrics import cross_pollution, token_f1
from ..nn.encoder import build_model, force_math_sdpa, model_param_count
from ..optim.groups import build_optimizer, reinit_label_rows
from ..optim.schedules import build_scheduler, restamp_resume_lrs
from ..protocols import TrainCallback
from ..tokenizer import Tokenizer
from .batch import precision_to_dtype, to_tensor_batch
from .callbacks import default_callbacks
from .callbacks.checkpointer import checkpoint_extras
from .checkpoint import find_latest_checkpoint, save_checkpoint
from .noise import perturb_anchor_confidence, perturb_evidence_noise, perturb_gazetteer_confidence
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
        latest = find_latest_checkpoint(output_dir)
        resume_from = latest

    # CharCNN input path (#825 / v8 CJK): data.char_mode and model.use_char_embed must agree — a
    # char-encoded batch into an SP model (or vice versa) is a config mistake, caught before any
    # loading. Char mode needs no SentencePiece tokenizer at all: the loader never calls it, and the
    # alignment smoke is SP-specific (the char path validates span-schema per row instead).
    char_mode = getattr(cfg.data, "char_mode", "off")
    use_char_embed = getattr(cfg.model, "use_char_embed", False)
    if (char_mode != "off") != use_char_embed:
        raise ValueError(f"data.char_mode={char_mode!r} and model.use_char_embed={use_char_embed} must be set together")
    char_vocab_size = 0
    if char_mode != "off":
        from ..tokenizer.char import load_char_vocab

        char_vocab_path = getattr(cfg.data, "char_vocab_path", None)
        if not char_vocab_path:
            raise ValueError("data.char_mode requires data.char_vocab_path")
        char_vocab_size = len(load_char_vocab(char_vocab_path))
        tokenizer = None
        print(f"char_mode={char_mode}: char_vocab_size={char_vocab_size}, SentencePiece path skipped")
    else:
        tokenizer = Tokenizer(Path(cfg.data.tokenizer_dir) / "tokenizer.model")
        verify_tokenizer_alignment(Path(cfg.data.corpus_dir), tokenizer)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if resume_from is not None:
        # Use the checkpoint's saved model rather than a fresh from-scratch init.
        from ..nn.encoder import MailwomanCoarseEncoder

        print(f"resuming from {resume_from}")
        model = MailwomanCoarseEncoder.from_pretrained(resume_from)
    else:
        model = build_model(
            cfg,
            # Char mode never reads the SP token-embedding table; vocab_size=2 keeps the unused
            # table at minimum width (an nn.Embedding needs >= pad_token_id + 1 rows).
            vocab_size=tokenizer.vocab_size if tokenizer is not None else 2,
            pad_token_id=tokenizer.pad_id if tokenizer is not None else 0,
            char_vocab_size=char_vocab_size,
        )
        # Fine-tune from a pre-trained encoder: load MODEL weights only (no optimizer/scheduler/
        # step, unlike resume), so the supervised run starts fresh on the MLM-pretrained encoder.
        # The pretrain checkpoint's state_dict is key-identical (tied MLM head adds no params), so
        # this loads cleanly; strict=False surfaces any head mismatch instead of raising.
        init_from = getattr(cfg.train, "init_from", "")
        if init_from:
            sd = torch.load(Path(init_from) / "pytorch_model.bin", map_location="cpu", weights_only=True)
            missing, unexpected = model.load_state_dict(sd, strict=False)
            print(f"[init_from] loaded encoder from {init_from} (missing={len(missing)} unexpected={len(unexpected)})")

        reinit = list(getattr(cfg.train, "reinit_label_rows", []) or [])
        if reinit:
            if not init_from:
                raise ValueError("train.reinit_label_rows requires train.init_from")
            reinit_label_rows(model, reinit)
    model.to(device)

    print(f"device={device} param_count={model_param_count(model):,}")
    print(f"gpu={torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'cpu-only'}")

    # #492 frozen-encoder probe: freeze everything except the affix head; the optimizer sees
    # only head params (a frozen param in AdamW is harmless but a filtered list is explicit).
    trainable_params = list(model.parameters())
    if getattr(cfg.train, "freeze_encoder", False):
        frozen = trainable = 0
        for name, p in model.named_parameters():
            if name.startswith("affix_head"):
                p.requires_grad = True
                trainable += p.numel()
            else:
                p.requires_grad = False
                frozen += p.numel()
        trainable_params = [p for p in model.parameters() if p.requires_grad]
        if not trainable_params:
            raise RuntimeError("freeze_encoder=True but no affix_head params found — set model.use_affix_head: true")
        print(f"[freeze_encoder] frozen={frozen:,} trainable={trainable:,} (affix head only)")

    # #901 v2.1.3: freeze ONLY the token-embedding table (the mean-init surgery rows). Mirrors
    # the freeze_encoder idiom — explicit filtered param list, loud count print.
    if getattr(cfg.train, "freeze_token_embeddings", False):
        frozen = 0
        for name, p in model.named_parameters():
            if "token_embeddings" in name:
                p.requires_grad = False
                frozen += p.numel()
        trainable_params = [p for p in model.parameters() if p.requires_grad]
        if frozen == 0:
            raise RuntimeError("freeze_token_embeddings=True but no token_embeddings params found")
        print(f"[freeze_token_embeddings] frozen={frozen:,} trainable={sum(p.numel() for p in trainable_params):,}")

    # 2026-07-22 cRT probe (census-bias plan "Parallel training-side experiment"): classifier-only
    # retraining with a frozen encoder — every param NOT matching a listed prefix is frozen, every
    # match stays trainable. Mirrors the freeze_encoder idiom above (explicit filtered param list,
    # loud count print, raise-if-empty). Mutually exclusive with freeze_encoder/freeze_token_embeddings:
    # all three exclude parts of the encoder from training, and combining them would make "which
    # setting produced the effect" ambiguous. See build_optimizer for the empty-base-group handling
    # this setting provokes when paired with a `classifier_learning_rate` carve-out (rest becomes empty).
    trainable_only_prefixes = tuple(getattr(cfg.train, "trainable_only_prefixes", []) or [])
    if trainable_only_prefixes:
        if getattr(cfg.train, "freeze_encoder", False) or getattr(cfg.train, "freeze_token_embeddings", False):
            raise ValueError(
                "train.trainable_only_prefixes is mutually exclusive with freeze_encoder/"
                "freeze_token_embeddings — combining them makes setting attribution ambiguous"
            )
        frozen = trainable = 0
        for name, p in model.named_parameters():
            if name.startswith(trainable_only_prefixes):
                p.requires_grad = True
                trainable += p.numel()
            else:
                p.requires_grad = False
                frozen += p.numel()
        trainable_params = [p for p in model.parameters() if p.requires_grad]
        if not trainable_params:
            raise RuntimeError(f"train.trainable_only_prefixes={list(trainable_only_prefixes)} matched no params")
        print(
            f"[trainable_only_prefixes] frozen={frozen:,} trainable={trainable:,} "
            f"(prefixes={list(trainable_only_prefixes)})"
        )

    # build_optimizer filters on requires_grad, so the freeze_* idioms above are honored without the
    # explicit trainable_params hand-off (a frozen param has requires_grad=False by then).
    optim, live_group_labels = build_optimizer(
        model,
        learning_rate=cfg.train.learning_rate,
        weight_decay=cfg.train.weight_decay,
        span_head_learning_rate=getattr(cfg.train, "span_head_learning_rate", None),
        classifier_learning_rate=getattr(cfg.train, "classifier_learning_rate", None),
    )
    # Captured BEFORE any resume load. `optim.load_state_dict()` (below, resume branch) silently
    # overwrites every param-group's `lr`/`initial_lr` with the CHECKPOINT's saved values, so
    # these live-config LRs — plus `live_group_labels` above, both sourced directly from
    # `build_optimizer`'s own return — are the only place the live values (and their group
    # attribution) survive resume. See `restamp_resume_lrs`.
    live_group_lrs = [g["lr"] for g in optim.param_groups]
    scheduler = build_scheduler(optim, cfg.train)
    print(f"lr_schedule={getattr(cfg.train, 'lr_schedule', 'cosine')}")
    amp_dtype = precision_to_dtype(cfg.train.precision, device)
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
            optim.load_state_dict(torch.load(opt_p, weights_only=False))  # nosec B614 — resume loads optimizer state WE wrote under this output_dir
        ts_p = resume_from_path / "training_state.json"
        if ts_p.is_file():
            ts = json.loads(ts_p.read_text(encoding="utf-8"))
            resume_step = int(ts.get("step", 0))
            # Resume-drift audit (#480): every config field that differs from the checkpoint's
            # stamped state is printed LOUDLY. Deliberate resume-with-changes is the campaign's
            # setting pattern (Run A/C); UNNOTICED drift is the Run-B-class confound. Visibility,
            # not prohibition.
            saved_cfg = ts.get("config", {})
            live_cfg = {"data": asdict(cfg.data), "model": asdict(cfg.model), "train": asdict(cfg.train)}
            drift: list[str] = []
            for section in ("data", "model", "train"):
                saved_section = saved_cfg.get(section, {})
                for key, live_val in live_cfg[section].items():
                    if key in ("output_dir", "max_steps", "trackio_run_name", "csv_log_path"):
                        continue  # expected to differ across resumes
                    saved_val = saved_section.get(key, "<absent>")
                    if saved_val != live_val:
                        drift.append(f"{section}.{key}: checkpoint={saved_val!r} -> live={live_val!r}")
            if drift:
                print(f"[resume-drift] {len(drift)} config field(s) differ from the checkpoint's stamped state:")
                for line in drift:
                    print(f"  ! {line}")
            else:
                print("[resume-drift] none — live config matches the checkpoint's stamped state")
        sched_p = resume_from_path / "scheduler.pt"
        if sched_p.is_file():
            scheduler.load_state_dict(torch.load(sched_p, weights_only=False))  # nosec B614 — same trusted checkpoint dir as the optimizer load above
        else:
            # Pre-resume-feature checkpoint: scheduler.pt didn't exist. Fast-forward the
            # scheduler so LR is correct for the resumed step. ``scheduler.step()`` is cheap.
            for _ in range(resume_step):
                scheduler.step()
        # Re-stamp the live config's LRs — must run AFTER both loads above, since either one
        # (optim.load_state_dict or scheduler.load_state_dict) can clobber them back to the
        # checkpoint's saved values. See `restamp_resume_lrs`.
        restamp_resume_lrs(optim, scheduler, live_group_lrs, live_group_labels)
        print(f"resumed at step={resume_step}")

    # Fisher capture + EWC (v8.3.0 Phase 1 — fisher.py has the design pointers). Capture is armed
    # for the FINAL window of the run; EWC loads the artifact + reference once, up front, loudly.
    fisher_acc = None
    fisher_window_start = None
    if getattr(cfg.train, "fisher_capture", False):
        from ..optim.fisher import FisherAccumulator

        fisher_acc = FisherAccumulator(model)
        fisher_window_start = cfg.train.max_steps - int(getattr(cfg.train, "fisher_capture_last_n_steps", 2000))
        print(f"[fisher] capture armed for steps >= {max(0, fisher_window_start)}")
    ewc = None
    if float(getattr(cfg.train, "ewc_lambda", 0.0)) > 0.0:
        from ..optim.fisher import EWCPenalty

        ewc_reference = getattr(cfg.train, "ewc_reference", None) or getattr(cfg.train, "init_from", "")
        ewc_fisher_path = getattr(cfg.train, "ewc_fisher_path", None)
        if not ewc_fisher_path or not ewc_reference:
            raise ValueError("train.ewc_lambda > 0 requires train.ewc_fisher_path and train.ewc_reference/init_from")
        ewc = EWCPenalty(
            ewc_fisher_path,
            ewc_reference,
            lam=float(cfg.train.ewc_lambda),
            device=device,
        )
        print(f"[ewc] λ={cfg.train.ewc_lambda:g}, {ewc.covered_params:,} params braked against {ewc_reference}")

    state = TrainState(
        cfg=cfg,
        model=model,
        tokenizer=tokenizer,
        device=device,
        optimizer=optim,
        scheduler=scheduler,
        output_dir=output_dir,
        started=time.time(),
        vocab_size=tokenizer.vocab_size if tokenizer is not None else 2,
    )
    if callbacks is None:
        callbacks = default_callbacks(cfg, resume_step=resume_step)
    for callback in callbacks:
        callback.on_train_begin(state)

    step = resume_step
    micro_step = 0
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
                tb = to_tensor_batch(batch, device)
                # Postcode-anchor confidence curriculum (#239/#240): perturb by optimizer step so the
                # model can't launder the anchor (no-op until 25% of max_steps).
                if "anchor_confidence" in tb:
                    tb["anchor_confidence"] = perturb_anchor_confidence(
                        tb["anchor_confidence"], step, cfg.train.max_steps
                    )
                # Gazetteer-anchor confidence curriculum (#464, v0.9.13): same ramped per-row zero-out
                # so the model keeps label competence with AND without the clue (recovers the v0.9.12
                # US postcode -3.7). Conditioned on the config flag so always-on runs stay reproducible.
                if "gazetteer_confidence" in tb and getattr(cfg.train, "gazetteer_curriculum", False):
                    tb["gazetteer_confidence"] = perturb_gazetteer_confidence(
                        tb["gazetteer_confidence"], step, cfg.train.max_steps
                    )
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
                                tb[fk], tb[ck] = perturb_evidence_noise(
                                    tb[fk], tb[ck], step, cfg.train.max_steps, noise_p
                                )
                    for key in ("street_type_confidence", "locality_surface_confidence"):
                        if key in tb:
                            tb[key] = perturb_gazetteer_confidence(tb[key], step, cfg.train.max_steps)
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
                # EWC brake (fine-tunes only): the quadratic penalty rides the loss INSIDE the
                # accum division so effective-batch scaling matches the data loss.
                loss_total = out.loss if ewc is None else out.loss + ewc.penalty(model)
                loss = loss_total / accum
                loss.backward()
                micro_step += 1
                if not is_accum_boundary:
                    continue
                # Fisher capture window (base runs): read the accumulated gradient BEFORE clipping
                # (the empirical Fisher is defined on ∂L/∂θ; the clipped surrogate understates
                # curvature exactly where it is largest). Read-only — trajectory unaffected.
                if fisher_acc is not None and fisher_window_start is not None and step >= fisher_window_start:
                    fisher_acc.accumulate(model)
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
                    state.val = _eval_val(cfg, tokenizer, model, device, max_rows=cfg.data.val_rows)
                    state.elapsed = time.time() - state.started
                    for callback in callbacks:
                        callback.on_eval_end(state, step, state.val)
        # Final save. This one stays in the loop: the Fisher artifact is written beside it, and a
        # run that reached its last step owes a checkpoint whether or not a callback is listening.
        final_ck = save_checkpoint(
            model,
            output_dir,
            step,
            checkpoint_extras(state, step),
            optim=optim,
            scheduler=scheduler,
        )
        # Fisher artifact lands BESIDE the final checkpoint (the weights-bundle contract: versioned
        # filename + provenance sidecar, the lexicon discipline). Zero-count capture (a run shorter
        # than its window says it was armed for) raises in finalize — loud, never a silent absence.
        if fisher_acc is not None:
            fisher_path = fisher_acc.save(
                final_ck,
                meta={
                    "captured_at_step": step,
                    "window_last_n_steps": int(getattr(cfg.train, "fisher_capture_last_n_steps", 2000)),
                    "corpus_dir": cfg.data.corpus_dir,
                    "seed": cfg.train.seed,
                    "output_dir": str(output_dir),
                },
            )
            print(f"[fisher] artifact → {fisher_path} ({fisher_acc.count} batches)")
    finally:
        # A crashed run still closes its CSV and its tracker, so the partial metrics survive.
        for callback in callbacks:
            callback.on_train_end(state)
