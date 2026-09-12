"""Everything a run decides before its first batch.

Each stage below answers one question the loop then takes as given: which tokenizer (or none),
which weights, which parameters are trainable, what the optimizer and scheduler are, and where in
a previous run's trajectory this one resumes. They are separate functions because each one can
refuse — a config that sets `char_mode` without `use_char_embed`, a freeze that matches no
parameter, an EWC lambda with no Fisher artifact — and a refusal should name the stage it came
from rather than a line number in a 400-line function.

ORDER IS LOAD-BEARING in exactly one place, and it is marked where it happens: the live learning
rates are captured before any checkpoint load, and re-stamped after both of them, because either
load silently overwrites them with the checkpoint's saved values.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import torch
from torch import nn
from torch.optim import AdamW
from torch.optim.lr_scheduler import LambdaLR

from ..config import Config
from ..nn.encoder import build_model, model_param_count
from ..optim.groups import build_optimizer, reinit_label_rows
from ..optim.schedules import build_scheduler, restamp_resume_lrs
from ..tokenizer import Tokenizer
from .batch import precision_to_dtype


@dataclass
class Optimization:
    """The optimizer and scheduler, plus what a resume must re-stamp onto them."""

    optimizer: AdamW
    scheduler: LambdaLR
    #: Captured BEFORE any resume load: `optim.load_state_dict()` overwrites every param-group's
    #: `lr`/`initial_lr` with the CHECKPOINT's values, so these are the only surviving live ones.
    live_group_lrs: list[float]
    live_group_labels: list[str]


@dataclass
class Precision:
    """How this run computes: the autocast dtype, whether autocast is used, and the accum width."""

    amp_dtype: torch.dtype | None
    use_amp_autocast: bool
    accum: int


@dataclass
class Regularizers:
    """The two optional curvature mechanisms, each None when its config flag is off."""

    fisher_acc: Any = None
    fisher_window_start: int | None = None
    ewc: Any = None


def resolve_tokenizer(cfg: Config) -> tuple[Tokenizer | None, int]:
    """The tokenizer this run encodes with, or None on the char path, plus the char vocab size.

    CharCNN input path (#825 / v8 CJK): data.char_mode and model.use_char_embed must agree — a
    char-encoded batch into an SP model (or vice versa) is a config mistake, caught before any
    loading. Char mode needs no SentencePiece tokenizer at all: the loader never calls it, and the
    alignment smoke is SP-specific (the char path validates span-schema per row instead).
    """
    from ..data.loader import verify_tokenizer_alignment

    char_mode = getattr(cfg.data, "char_mode", "off")
    use_char_embed = getattr(cfg.model, "use_char_embed", False)
    if (char_mode != "off") != use_char_embed:
        raise ValueError(f"data.char_mode={char_mode!r} and model.use_char_embed={use_char_embed} must be set together")
    if char_mode != "off":
        from ..tokenizer.char import load_char_vocab

        char_vocab_path = getattr(cfg.data, "char_vocab_path", None)
        if not char_vocab_path:
            raise ValueError("data.char_mode requires data.char_vocab_path")
        char_vocab_size = len(load_char_vocab(char_vocab_path))
        print(f"char_mode={char_mode}: char_vocab_size={char_vocab_size}, SentencePiece path skipped")
        return None, char_vocab_size

    tokenizer = Tokenizer(Path(cfg.data.tokenizer_dir) / "tokenizer.model")
    verify_tokenizer_alignment(Path(cfg.data.corpus_dir), tokenizer)
    return tokenizer, 0


def load_or_build_model(
    cfg: Config,
    *,
    resume_from: str | Path | None,
    tokenizer: Tokenizer | None,
    char_vocab_size: int,
    device: torch.device,
) -> nn.Module:
    """The weights this run starts from: a checkpoint, a pre-trained encoder, or a fresh init."""
    if resume_from is not None:
        # Use the checkpoint's saved model rather than a fresh from-scratch init.
        from ..nn.encoder import MailwomanCoarseEncoder

        print(f"resuming from {resume_from}")
        model: nn.Module = MailwomanCoarseEncoder.from_pretrained(resume_from)
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
    return model


def apply_freezes(cfg: Config, model: nn.Module) -> None:
    """Set `requires_grad` per the three mutually-aware freeze settings, loudly.

    `build_optimizer` filters on `requires_grad`, so flipping the flag here is the whole hand-off —
    no explicit parameter list travels onward. Each setting raises rather than training nothing.
    """
    # #492 frozen-encoder probe: freeze everything except the affix head; the optimizer sees
    # only head params (a frozen param in AdamW is harmless but a filtered list is explicit).
    if getattr(cfg.train, "freeze_encoder", False):
        frozen = trainable = 0
        for name, p in model.named_parameters():
            if name.startswith("affix_head"):
                p.requires_grad = True
                trainable += p.numel()
            else:
                p.requires_grad = False
                frozen += p.numel()
        if not any(p.requires_grad for p in model.parameters()):
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
        if frozen == 0:
            raise RuntimeError("freeze_token_embeddings=True but no token_embeddings params found")
        live = sum(p.numel() for p in model.parameters() if p.requires_grad)
        print(f"[freeze_token_embeddings] frozen={frozen:,} trainable={live:,}")

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
        if not any(p.requires_grad for p in model.parameters()):
            raise RuntimeError(f"train.trainable_only_prefixes={list(trainable_only_prefixes)} matched no params")
        print(
            f"[trainable_only_prefixes] frozen={frozen:,} trainable={trainable:,} "
            f"(prefixes={list(trainable_only_prefixes)})"
        )


def build_optimization(cfg: Config, model: nn.Module) -> Optimization:
    """The optimizer and scheduler, with the live learning rates captured before any resume load."""
    optim, live_group_labels = build_optimizer(
        model,
        learning_rate=cfg.train.learning_rate,
        weight_decay=cfg.train.weight_decay,
        span_head_learning_rate=getattr(cfg.train, "span_head_learning_rate", None),
        classifier_learning_rate=getattr(cfg.train, "classifier_learning_rate", None),
    )
    # Captured BEFORE any resume load. `optim.load_state_dict()` (in `restore_training_state`)
    # silently overwrites every param-group's `lr`/`initial_lr` with the CHECKPOINT's saved values,
    # so these live-config LRs — plus `live_group_labels` above, both sourced directly from
    # `build_optimizer`'s own return — are the only place the live values (and their group
    # attribution) survive resume. See `restamp_resume_lrs`.
    live_group_lrs = [g["lr"] for g in optim.param_groups]
    scheduler = build_scheduler(optim, cfg.train)
    print(f"lr_schedule={getattr(cfg.train, 'lr_schedule', 'cosine')}")
    return Optimization(optim, scheduler, live_group_lrs, live_group_labels)


def resolve_precision(cfg: Config, model: nn.Module, device: torch.device) -> Precision:
    """The compute dtype, and why autocast is off on GPU.

    On gfx1103 (Radeon 780M) autocast+bf16 has been observed to hang at batch>=64 with
    nn.MultiheadAttention — the autocast fast-path picks a fused kernel that GPU hangs on.
    Cast the whole model to bf16 explicitly instead: equivalent throughput, no fast-path.
    """
    amp_dtype = precision_to_dtype(cfg.train.precision, device)
    if amp_dtype is not None and device.type == "cuda":
        model.to(dtype=amp_dtype)
    # Effective batch size = batch_size × grad_accum_steps. Optimizer steps every `accum` calls.
    return Precision(amp_dtype, use_amp_autocast=False, accum=max(1, int(cfg.train.grad_accum_steps)))


def restore_training_state(cfg: Config, resume_from: str | Path | None, optimization: Optimization) -> int:
    """Load the optimizer, the scheduler and the step a resume continues from. Returns that step."""
    if resume_from is None:
        return 0
    optim, scheduler = optimization.optimizer, optimization.scheduler
    resume_from_path = Path(resume_from)
    resume_step = 0
    opt_p = resume_from_path / "optimizer.pt"
    if opt_p.is_file():
        optim.load_state_dict(torch.load(opt_p, weights_only=False))  # nosec B614 — resume loads optimizer state WE wrote under this output_dir
    ts_p = resume_from_path / "training_state.json"
    if ts_p.is_file():
        ts = json.loads(ts_p.read_text(encoding="utf-8"))
        resume_step = int(ts.get("step", 0))
        _report_resume_drift(cfg, ts.get("config", {}))
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
    restamp_resume_lrs(optim, scheduler, optimization.live_group_lrs, optimization.live_group_labels)
    print(f"resumed at step={resume_step}")
    return resume_step


def _report_resume_drift(cfg: Config, saved_cfg: dict[str, Any]) -> None:
    """Print every config field that differs from the checkpoint's stamped state (#480).

    Deliberate resume-with-changes is the campaign's setting pattern (Run A/C); UNNOTICED drift is
    the Run-B-class confound. Visibility, not prohibition.
    """
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


def build_regularizers(cfg: Config, model: nn.Module, device: torch.device) -> Regularizers:
    """Fisher capture + EWC (v8.3.0 Phase 1 — fisher.py has the design pointers).

    Capture is armed for the FINAL window of the run; EWC loads the artifact + reference once, up
    front, loudly.
    """
    out = Regularizers()
    if getattr(cfg.train, "fisher_capture", False):
        from ..optim.fisher import FisherAccumulator

        out.fisher_acc = FisherAccumulator(model)
        out.fisher_window_start = cfg.train.max_steps - int(getattr(cfg.train, "fisher_capture_last_n_steps", 2000))
        print(f"[fisher] capture armed for steps >= {max(0, out.fisher_window_start)}")
    if float(getattr(cfg.train, "ewc_lambda", 0.0)) > 0.0:
        from ..optim.fisher import EWCPenalty

        ewc_reference = getattr(cfg.train, "ewc_reference", None) or getattr(cfg.train, "init_from", "")
        ewc_fisher_path = getattr(cfg.train, "ewc_fisher_path", None)
        if not ewc_fisher_path or not ewc_reference:
            raise ValueError("train.ewc_lambda > 0 requires train.ewc_fisher_path and train.ewc_reference/init_from")
        out.ewc = EWCPenalty(
            ewc_fisher_path,
            ewc_reference,
            lam=float(cfg.train.ewc_lambda),
            device=device,
        )
        print(f"[ewc] λ={cfg.train.ewc_lambda:g}, {out.ewc.covered_params:,} params braked against {ewc_reference}")
    return out
