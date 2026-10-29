"""Record what the Python trainer computes, for the Rust trainer's staged comparison (#2874, plan §3.3).

The Rust trainer in `packages/trainer` issues the same libtorch operations as `nn/`, `train/` and `optim/`. This
module writes the reference each stage compares against, under `$MAILWOMAN_DATA_ROOT/audits/trainer-parity/`:

- `f1 --out <dir>`: one pre-norm `EncoderBlock` (`MultiheadAttention`, `LayerNorm`, GELU) built from a seed, its
  forward in eval and train mode, the backward of a fixed cotangent, and three AdamW steps under the cosine
  `LambdaLR` schedule with gradient clipping. This is the F1 feasibility check.
- `capture --config <yaml> --checkpoint <dir> --cell <name> --out <dir>`: one matrix cell. It saves the model's
  initial and loaded parameters, the training batches the loader draws, the forward outputs and each loss term in
  eval and train mode, the gradients, and the parameters after each optimizer step, plus the schedule's rates.
- `train --config <yaml>`: the real `train()` loop at a fixed thread count: the 200-step reference run that writes
  the reference checkpoint, and the stage-7 run from `train.init_from`.

Tensors are written as safetensors by `write_safetensors` below, so the record needs no package beyond torch. The
Rust side reads them with the `safetensors` crate. This module is temporary: it is deleted with the Python trainer.

Usage:

    python -m mailwoman_train.audits.trainer_parity f1 --out <dir> [--threads 4]
    python -m mailwoman_train.audits.trainer_parity train --config <yaml> [--set section.key=value] [--threads 4]
    python -m mailwoman_train.audits.trainer_parity capture --config <yaml> --checkpoint <dir> --cell <name> \\
        --out <dir> [--set section.key=value] [--batches 2] [--autocast] [--curriculum-step 120]
"""

from __future__ import annotations

import argparse
import json
import struct
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import torch

#: The safetensors dtype names of the dtypes a record holds.
_DTYPES = {
    torch.float32: "F32",
    torch.bfloat16: "BF16",
    torch.float16: "F16",
    torch.int64: "I64",
    torch.int32: "I32",
    torch.bool: "BOOL",
}


def write_safetensors(path: Path, tensors: Iterable[tuple[str, torch.Tensor]]) -> None:
    """Write tensors in the safetensors layout: a little-endian u64 header length, the JSON header, the bytes."""
    header: dict[str, Any] = {}
    chunks: list[bytes] = []
    offset = 0
    for name, tensor in tensors:
        t = tensor.detach().to("cpu").contiguous()
        if t.dtype == torch.bfloat16:
            data = t.view(torch.int16).numpy().tobytes()
        else:
            data = t.numpy().tobytes()
        header[name] = {"dtype": _DTYPES[t.dtype], "shape": list(t.shape), "data_offsets": [offset, offset + len(data)]}
        chunks.append(data)
        offset += len(data)
    encoded = json.dumps(header, separators=(",", ":")).encode("utf-8")
    encoded += b" " * ((8 - len(encoded) % 8) % 8)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        f.write(struct.pack("<Q", len(encoded)))
        f.write(encoded)
        for chunk in chunks:
            f.write(chunk)


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def _runtime() -> dict[str, Any]:
    import platform

    return {
        "python": platform.python_version(),
        "torch": torch.__version__,
        "threads": torch.get_num_threads(),
        "cpu_capability": torch.backends.cpu.get_cpu_capability(),
    }


def _grads(named: Iterable[tuple[str, torch.nn.Parameter]]) -> list[tuple[str, torch.Tensor]]:
    # A copy: clipping scales the gradient in place after it is recorded.
    return [(f"grad.{n}", p.grad.detach().clone()) for n, p in named if p.grad is not None]


def run_f1(out: Path, hidden: int, heads: int, ff: int, seq: int) -> None:
    """The F1 block check: construction, forward, backward, three AdamW steps under the cosine schedule."""
    from ..nn.blocks import EncoderBlock
    from ..optim.schedules import cosine_with_warmup

    dropout = 0.1
    torch.manual_seed(0)
    block = EncoderBlock(hidden, heads, ff, dropout)
    init = [(f"init.{n}", t.clone()) for n, t in block.state_dict().items()]
    gen = torch.Generator().manual_seed(1)
    x = torch.randn(4, seq, hidden, generator=gen)
    cot = torch.randn(4, seq, hidden, generator=gen)
    mask = torch.ones(4, seq, dtype=torch.long)
    mask[1, seq * 5 // 8 :] = 0
    mask[3, seq // 6 :] = 0
    kpm = mask == 0
    tensors: list[tuple[str, torch.Tensor]] = [*init, ("x", x), ("cot", cot), ("mask", mask)]

    block.eval()
    with torch.no_grad():
        tensors.append(("eval_nograd", block(x, kpm)))
    xg = x.clone().requires_grad_(True)
    out_eval = block(xg, kpm)
    tensors.append(("eval", out_eval.detach()))
    (out_eval * cot).sum().backward()
    if xg.grad is None:
        raise RuntimeError("the block's backward left no gradient on its input")
    tensors += [("eval.grad.x", xg.grad), *[(f"eval.{n}", g) for n, g in _grads(block.named_parameters())]]

    block.train()
    optim = torch.optim.AdamW(block.parameters(), lr=5e-4, weight_decay=0.01)
    scheduler = cosine_with_warmup(optim, warmup_steps=2, max_steps=10)
    lrs = [scheduler.get_last_lr()[0]]
    norms = []
    for step in range(3):
        optim.zero_grad(set_to_none=True)
        torch.manual_seed(100 + step)
        y = block(x, kpm)
        tensors.append((f"train{step}.out", y.detach()))
        (y * cot).sum().backward()
        tensors += [(f"train{step}.{n}", g) for n, g in _grads(block.named_parameters())]
        norms.append(float(torch.nn.utils.clip_grad_norm_(block.parameters(), max_norm=1.0)))
        optim.step()
        scheduler.step()
        lrs.append(scheduler.get_last_lr()[0])
        tensors += [(f"train{step}.param.{n}", p.detach().clone()) for n, p in block.named_parameters()]
    write_safetensors(out / "f1.safetensors", tensors)
    _write_json(
        out / "f1.json",
        {
            "runtime": _runtime(),
            "dims": {"hidden": hidden, "heads": heads, "ff": ff, "seq": seq},
            "param_order": [n for n, _ in block.named_parameters()],
            "lrs": lrs,
            "grad_norms": norms,
            "schedule_multipliers": {str(s): scheduler.lr_lambdas[0](s) for s in (0, 1, 2, 5, 10, 11)},
        },
    )
    print(f"[f1] wrote {out}")


def _load(config: str, overrides: list[str]) -> Any:
    """The config at `config` with each `section.key=value` override applied, the value parsed as YAML."""
    import yaml

    from ..config import load_config

    cfg = load_config(config)
    for override in overrides:
        key, sep, raw = override.partition("=")
        section, dot, attribute = key.partition(".")
        if not sep or not dot or not hasattr(getattr(cfg, section, None), attribute):
            raise ValueError(f"--set expects section.key=value naming an existing field, got {override!r}")
        setattr(getattr(cfg, section), attribute, yaml.safe_load(raw))
    return cfg


def _loss_terms(model: Any, tb: dict[str, Any], out: Any, hidden: torch.Tensor) -> list[tuple[str, torch.Tensor]]:
    """Each unweighted loss term `losses.py` and `address_system.py` sum, recomputed from the forward's outputs.

    The total is the model's own `out.loss`; the terms let a mismatch be attributed. The span-boundary head reads
    `hidden`, the classifier's input.
    """
    from torch import nn

    from ..labels import IGNORE_INDEX

    terms: list[tuple[str, torch.Tensor]] = []
    labels, mask, logits = tb["labels"], tb["attention_mask"], out.logits
    kwargs: dict[str, Any] = {"ignore_index": -100, "label_smoothing": model.label_smoothing}
    if isinstance(model.class_weights, torch.Tensor):
        kwargs["weight"] = model.class_weights
    terms.append(("ce", nn.functional.cross_entropy(logits.view(-1, model.num_labels), labels.view(-1), **kwargs)))
    if model.crf is not None and model.crf_loss_weight > 0:
        reduction = "per_token" if model.crf_normalization == "per_token" else "mean"
        terms.append(
            (
                "crf",
                model.crf(emissions=logits, tags=labels.clamp(min=0), mask=mask.to(logits.dtype), reduction=reduction),
            )
        )
    locale_ids = tb.get("locale_ids")
    if (
        out.locale_logits is not None
        and locale_ids is not None
        and model.locale_loss_weight > 0
        and bool((locale_ids != IGNORE_INDEX).any())
    ):
        terms.append(
            ("locale", nn.functional.cross_entropy(out.locale_logits.float(), locale_ids, ignore_index=IGNORE_INDEX))
        )
    if model.use_span_boundary_head and model.span_boundary_loss_weight > 0:
        valid = mask.bool() & labels.ne(-100)
        if bool(valid.any()):
            safe = labels.clamp_min(0)
            is_b, is_i = model.bio_is_begin[safe], model.bio_is_inside[safe]
            next_is_i = torch.zeros_like(is_i)
            next_is_i[:, :-1] = is_i[:, 1:]
            targets = torch.stack([is_b.float(), ((is_b | is_i) & ~next_is_i).float()], dim=-1)
            per_pos = nn.functional.binary_cross_entropy_with_logits(
                model.span_boundary_head(hidden).float(), targets, reduction="none"
            ).mean(dim=-1)
            terms.append(("span_boundary", per_pos[valid].mean()))
    ids = tb.get("address_system_ids")
    if (
        out.address_system_logits is not None
        and ids is not None
        and model.address_system_loss_weight > 0
        and bool((ids != IGNORE_INDEX).any())
    ):
        terms.append(
            (
                "address_system",
                nn.functional.cross_entropy(out.address_system_logits.float(), ids, ignore_index=IGNORE_INDEX),
            )
        )
    return terms


def _forward(model: Any, tb: dict[str, Any], mlm: Any, autocast: bool) -> tuple[Any, list[tuple[str, torch.Tensor]]]:
    """One forward pass with its loss terms, under CPU autocast when asked."""
    captured: list[torch.Tensor] = []
    handle = model.classifier.register_forward_pre_hook(lambda _m, args: captured.append(args[0]))
    try:
        with torch.autocast(device_type="cpu", dtype=torch.bfloat16, enabled=autocast):
            if mlm is not None:
                out = model.forward_mlm(input_ids=mlm[0], attention_mask=tb["attention_mask"], mlm_labels=mlm[1])
                terms = [("mlm", out.loss)]
            else:
                out = model(**tb)
                terms = _loss_terms(model, tb, out, captured[0]) if captured else []
    finally:
        handle.remove()
    return out, terms


def _outputs(prefix: str, out: Any, terms: list[tuple[str, torch.Tensor]]) -> list[tuple[str, torch.Tensor]]:
    rows = [(f"{prefix}.logits", out.logits.detach()), (f"{prefix}.loss", out.loss.detach().reshape(()))]
    for name in ("locale_logits", "address_system_logits"):
        value = getattr(out, name, None)
        if value is not None:
            rows.append((f"{prefix}.{name}", value.detach()))
    rows += [(f"{prefix}.term.{n}", t.detach().reshape(())) for n, t in terms]
    return rows


def run_capture(args: argparse.Namespace) -> None:
    """One cell of the staged comparison's matrix: stages 1 to 5 on saved batches."""
    import itertools

    from ..data.loader import iter_training_batches
    from ..data.masking import mask_tokens
    from ..nn.encoder import build_model
    from ..train.batch import to_tensor_batch
    from ..train.loop import apply_curricula
    from ..train.setup import apply_freezes, build_optimization, resolve_encoder, resolve_tokenizer

    out_dir = Path(args.out)
    cfg = _load(args.config, args.overrides)
    mlm = cfg.train.objective == "mlm"
    accum = max(1, int(cfg.train.grad_accum_steps))
    tokenizer, char_vocab_size = resolve_tokenizer(cfg)
    encoder = resolve_encoder(cfg, tokenizer)
    vocab = tokenizer.vocab_size if tokenizer is not None else 2
    pad = tokenizer.pad_id if tokenizer is not None else 0
    seed = int(cfg.train.seed)

    torch.manual_seed(seed)
    model = build_model(cfg, vocab_size=vocab, pad_token_id=pad, char_vocab_size=char_vocab_size)
    tensors: list[tuple[str, torch.Tensor]] = [(f"init.{n}", t.clone()) for n, t in model.state_dict().items()]
    missing: list[str] = []
    unexpected: list[str] = []
    if args.checkpoint:
        sd = torch.load(Path(args.checkpoint) / "pytorch_model.bin", map_location="cpu", weights_only=True)
        missing, unexpected = (list(x) for x in model.load_state_dict(sd, strict=False))
    tensors += [(f"params.{n}", t.clone()) for n, t in model.state_dict().items()]
    apply_freezes(cfg, model)

    n_batches = args.batches * accum
    raw = list(
        itertools.islice(
            iter_training_batches(
                cfg, encoder, batch_size=cfg.train.batch_size, seed=seed, row_limit=cfg.data.train_rows_per_epoch
            ),
            n_batches,
        )
    )
    batches = [to_tensor_batch(b, torch.device("cpu")) for b in raw]
    for i, tb in enumerate(batches):
        tensors += [(f"batch{i}.{k}", v) for k, v in tb.items()]
    masks: list[tuple[torch.Tensor, torch.Tensor] | None] = [None] * len(batches)
    if mlm:
        gen = torch.Generator().manual_seed(seed)
        mask_id = tokenizer.unk_id if tokenizer is not None else 1
        for i, tb in enumerate(batches):
            masked, mlm_labels = mask_tokens(
                tb["input_ids"],
                tb["attention_mask"],
                mask_prob=cfg.train.mlm_mask_prob,
                mask_token_id=mask_id,
                vocab_size=vocab,
                generator=gen,
            )
            masks[i] = (masked, mlm_labels)
            tensors += [(f"batch{i}.mlm_input_ids", masked), (f"batch{i}.mlm_labels", mlm_labels)]

    # Stages 2 to 4 in eval mode. Eval mode draws no dropout mask and no hint. The comparison then sees the arithmetic.
    model.eval()
    out, terms = _forward(model, batches[0], masks[0], args.autocast)
    tensors += _outputs("eval", out, terms)
    out.loss.backward()
    tensors += [(f"eval.{n}", g) for n, g in _grads(model.named_parameters())]
    model.zero_grad(set_to_none=True)

    # The same in train mode from a fixed generator state: dropout, the hint draws and the curricula.
    model.train()
    torch.manual_seed(seed + 7)
    tb = {k: v.clone() for k, v in batches[0].items()}
    # The MLM loop applies no curricula, so its train-mode pass draws only dropout.
    if not mlm:
        apply_curricula(cfg, tb, args.curriculum_step)
    tensors += [(f"train.curriculum.{k}", v) for k, v in tb.items() if k.endswith(("_features", "_confidence"))]
    out, terms = _forward(model, tb, masks[0], args.autocast)
    tensors += _outputs("train", out, terms)
    out.loss.backward()
    tensors += [(f"train.{n}", g) for n, g in _grads(model.named_parameters())]
    model.zero_grad(set_to_none=True)

    # Stage 5: the loop's optimizer steps over the saved batches, `accum` micro-batches each.
    if mlm:
        from torch.optim import AdamW

        from ..optim.schedules import build_scheduler

        optim: Any = AdamW(model.parameters(), lr=cfg.train.learning_rate, weight_decay=cfg.train.weight_decay)
        scheduler: Any = build_scheduler(optim, cfg.train)
    else:
        optimization = build_optimization(cfg, model)
        optim, scheduler = optimization.optimizer, optimization.scheduler
    torch.manual_seed(seed + 11)
    lrs = [scheduler.get_last_lr()]
    norms = []
    losses = []
    for step in range(args.batches):
        optim.zero_grad(set_to_none=True)
        for micro in range(accum):
            i = step * accum + micro
            tb = {k: v.clone() for k, v in batches[i].items()}
            if not mlm:
                apply_curricula(cfg, tb, args.curriculum_step)
            out, _ = _forward(model, tb, masks[i], args.autocast)
            loss = out.loss / accum
            loss.backward()
            losses.append(float(loss.detach()))
        norms.append(
            float(torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=float(cfg.train.grad_clip_norm)))
        )
        optim.step()
        scheduler.step()
        lrs.append(scheduler.get_last_lr())
        tensors += [(f"step{step}.{n}", p.detach().clone()) for n, p in model.named_parameters()]
    lam = scheduler.lr_lambdas[0]
    max_steps, warmup = int(cfg.train.max_steps), int(cfg.train.warmup_steps)
    probe_steps = sorted({0, 1, 100, warmup, max_steps})
    write_safetensors(out_dir / "record.safetensors", tensors)
    _write_json(
        out_dir / "record.json",
        {
            "cell": args.cell,
            "config": str(Path(args.config).resolve()),
            "overrides": args.overrides,
            "checkpoint": args.checkpoint,
            "missing_keys": missing,
            "unexpected_keys": unexpected,
            "seed": seed,
            "batches": args.batches,
            "accum": accum,
            "objective": cfg.train.objective,
            "autocast": "bf16" if args.autocast else None,
            "curriculum_step": args.curriculum_step,
            "param_order": [n for n, _ in model.named_parameters()],
            "group_sizes": [len(g["params"]) for g in optim.param_groups],
            "lrs": lrs,
            "grad_norms": norms,
            "micro_losses": losses,
            "schedule": {str(s): lam(s) for s in probe_steps},
            "runtime": _runtime(),
        },
    )
    print(f"[capture] {args.cell}: {len(batches)} batches, {len(tensors)} tensors -> {out_dir}")


def run_train(args: argparse.Namespace) -> None:
    """`train()` on a config, the smoke run and the stage-7 run."""
    from ..train.trainer import train

    cfg = _load(args.config, args.overrides)
    train(cfg, resume_from=args.resume)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="trainer_parity")
    sub = parser.add_subparsers(dest="command", required=True)
    f1 = sub.add_parser("f1")
    f1.add_argument("--out", required=True)
    f1.add_argument("--hidden", type=int, default=384)
    f1.add_argument("--heads", type=int, default=6)
    f1.add_argument("--ff", type=int, default=1536)
    f1.add_argument("--seq", type=int, default=32)
    cap = sub.add_parser("capture")
    cap.add_argument("--config", required=True)
    cap.add_argument("--checkpoint", default=None)
    cap.add_argument("--cell", required=True)
    cap.add_argument("--out", required=True)
    cap.add_argument("--set", dest="overrides", action="append", default=[])
    cap.add_argument("--batches", type=int, default=2)
    cap.add_argument("--autocast", action="store_true")
    cap.add_argument("--curriculum-step", type=int, default=120)
    tr = sub.add_parser("train")
    tr.add_argument("--config", required=True)
    tr.add_argument("--set", dest="overrides", action="append", default=[])
    tr.add_argument("--resume", default=None)
    for p in (f1, cap, tr):
        p.add_argument("--threads", type=int, default=4)
    args = parser.parse_args(argv)
    torch.set_num_threads(args.threads)
    if args.command == "f1":
        run_f1(Path(args.out), args.hidden, args.heads, args.ff, args.seq)
    elif args.command == "capture":
        run_capture(args)
    else:
        run_train(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
