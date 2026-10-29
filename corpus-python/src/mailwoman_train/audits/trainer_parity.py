"""Record what the Python trainer computes, for the Rust trainer's staged comparison (#2874, plan §3.3).

The Rust trainer in `packages/trainer` issues the same libtorch operations as `nn/`, `train/` and `optim/`. This
module writes the reference each stage compares against, under `$MAILWOMAN_DATA_ROOT/audits/trainer-parity/`:

- `f1 --out <dir>`: one pre-norm `EncoderBlock` (`MultiheadAttention`, `LayerNorm`, GELU) built from a seed, its
  forward in eval and train mode, the backward of a fixed cotangent, and three AdamW steps under the cosine
  `LambdaLR` schedule with gradient clipping. This is the F1 feasibility check.
- `smoke --config <yaml>`: the real `train()` loop at a fixed thread count, which writes the reference checkpoint
  and its `train_log.csv`.
- `capture --config <yaml> --checkpoint <dir> --cell <name> --out <dir>`: one matrix cell. It saves the model's
  parameters, the training batches the loader draws, and per batch the forward outputs, each loss term, the
  gradients, and the parameters after one optimizer step, plus the schedule's rates.
- `train --config <yaml>`: the stage-7 run, `train()` from `train.init_from`.

Tensors are written as safetensors by `write_safetensors` below, so the record needs no package beyond torch. The
Rust side reads them with the `safetensors` crate. This module is temporary: it is deleted with the Python trainer.

Usage:

    python -m mailwoman_train.audits.trainer_parity f1 --out <dir> [--threads 4]
    python -m mailwoman_train.audits.trainer_parity smoke --config <yaml> [--threads 4]
    python -m mailwoman_train.audits.trainer_parity capture --config <yaml> --checkpoint <dir> --cell <name> \\
        --out <dir> [--set section.key=value] [--batches 2] [--accum 1] [--autocast bf16] [--objective mlm]
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


def run_f1(out: Path) -> None:
    """The F1 block check: construction, forward, backward, three AdamW steps under the cosine schedule."""
    from ..nn.blocks import EncoderBlock
    from ..optim.schedules import cosine_with_warmup

    hidden, heads, ff, dropout = 384, 6, 1536, 0.1
    torch.manual_seed(0)
    block = EncoderBlock(hidden, heads, ff, dropout)
    init = [(f"init.{n}", t.clone()) for n, t in block.state_dict().items()]
    gen = torch.Generator().manual_seed(1)
    x = torch.randn(4, 32, hidden, generator=gen)
    cot = torch.randn(4, 32, hidden, generator=gen)
    mask = torch.ones(4, 32, dtype=torch.long)
    mask[1, 20:] = 0
    mask[3, 5:] = 0
    kpm = mask == 0
    tensors: list[tuple[str, torch.Tensor]] = [*init, ("x", x), ("cot", cot), ("mask", mask)]

    block.eval()
    with torch.no_grad():
        tensors.append(("eval_nograd", block(x, kpm)))
    xg = x.clone().requires_grad_(True)
    out_eval = block(xg, kpm)
    tensors.append(("eval", out_eval.detach()))
    (out_eval * cot).sum().backward()
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
            "param_order": [n for n, _ in block.named_parameters()],
            "lrs": lrs,
            "grad_norms": norms,
            "schedule_multipliers": {
                str(s): scheduler.lr_lambdas[0](s) for s in (0, 1, 2, 5, 10, 11)  # type: ignore[attr-defined]
            },
        },
    )
    print(f"[f1] wrote {out}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="trainer_parity")
    sub = parser.add_subparsers(dest="command", required=True)
    f1 = sub.add_parser("f1")
    f1.add_argument("--out", required=True)
    f1.add_argument("--threads", type=int, default=4)
    args = parser.parse_args(argv)
    torch.set_num_threads(args.threads)
    if args.command == "f1":
        run_f1(Path(args.out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
