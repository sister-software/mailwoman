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
    optimizer: AdamW
    scheduler: LambdaLR

    live_group_lrs: list[float]
    live_group_labels: list[str]


@dataclass
class Precision:
    amp_dtype: torch.dtype | None
    use_amp_autocast: bool
    accum: int


@dataclass
class Regularizers:
    fisher_acc: Any = None
    fisher_window_start: int | None = None
    ewc: Any = None


def resolve_tokenizer(cfg: Config) -> tuple[Tokenizer | None, int]:
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
    if resume_from is not None:
        from ..nn.encoder import MailwomanCoarseEncoder

        print(f"resuming from {resume_from}")
        model: nn.Module = MailwomanCoarseEncoder.from_pretrained(resume_from)
    else:
        model = build_model(
            cfg,
            vocab_size=tokenizer.vocab_size if tokenizer is not None else 2,
            pad_token_id=tokenizer.pad_id if tokenizer is not None else 0,
            char_vocab_size=char_vocab_size,
        )

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
    optim, live_group_labels = build_optimizer(
        model,
        learning_rate=cfg.train.learning_rate,
        weight_decay=cfg.train.weight_decay,
        span_head_learning_rate=getattr(cfg.train, "span_head_learning_rate", None),
        classifier_learning_rate=getattr(cfg.train, "classifier_learning_rate", None),
    )

    live_group_lrs = [g["lr"] for g in optim.param_groups]
    scheduler = build_scheduler(optim, cfg.train)
    print(f"lr_schedule={getattr(cfg.train, 'lr_schedule', 'cosine')}")
    return Optimization(optim, scheduler, live_group_lrs, live_group_labels)


def resolve_precision(cfg: Config, model: nn.Module, device: torch.device) -> Precision:
    amp_dtype = precision_to_dtype(cfg.train.precision, device)
    if amp_dtype is not None and device.type == "cuda":
        model.to(dtype=amp_dtype)

    return Precision(amp_dtype, use_amp_autocast=False, accum=max(1, int(cfg.train.grad_accum_steps)))


def restore_training_state(cfg: Config, resume_from: str | Path | None, optimization: Optimization) -> int:
    if resume_from is None:
        return 0
    optim, scheduler = optimization.optimizer, optimization.scheduler
    resume_from_path = Path(resume_from)
    resume_step = 0
    opt_p = resume_from_path / "optimizer.pt"
    if opt_p.is_file():
        optim.load_state_dict(torch.load(opt_p, weights_only=False))  # nosec B614
    ts_p = resume_from_path / "training_state.json"
    if ts_p.is_file():
        ts = json.loads(ts_p.read_text(encoding="utf-8"))
        resume_step = int(ts.get("step", 0))
        _report_resume_drift(cfg, ts.get("config", {}))
    sched_p = resume_from_path / "scheduler.pt"
    if sched_p.is_file():
        scheduler.load_state_dict(torch.load(sched_p, weights_only=False))  # nosec B614
    else:
        for _ in range(resume_step):
            scheduler.step()

    restamp_resume_lrs(optim, scheduler, optimization.live_group_lrs, optimization.live_group_labels)
    print(f"resumed at step={resume_step}")
    return resume_step


def _report_resume_drift(cfg: Config, saved_cfg: dict[str, Any]) -> None:
    live_cfg = {"data": asdict(cfg.data), "model": asdict(cfg.model), "train": asdict(cfg.train)}
    drift: list[str] = []
    for section in ("data", "model", "train"):
        saved_section = saved_cfg.get(section, {})
        for key, live_val in live_cfg[section].items():
            if key in ("output_dir", "max_steps", "trackio_run_name", "csv_log_path"):
                continue
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
