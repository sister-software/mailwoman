"""`resolve_precision` keeps fp32 master weights under bf16 autocast on NVIDIA and casts the model elsewhere.

A `torch.device("cuda")` object needs no GPU to construct, so each case runs on CPU with the device type and the ROCm
marker `torch.version.hip` set by the test.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
import torch

from mailwoman_train.train.setup import resolve_precision

CUDA = torch.device("cuda")
CPU = torch.device("cpu")


def config(precision: str, accum: int = 1) -> Any:
    return SimpleNamespace(train=SimpleNamespace(precision=precision, grad_accum_steps=accum))


def model() -> torch.nn.Module:
    return torch.nn.Linear(4, 2)


def dtypes(module: torch.nn.Module) -> set[torch.dtype]:
    return {p.dtype for p in module.parameters()}


def test_bf16_on_nvidia_keeps_fp32_parameters_and_autocasts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(torch.version, "hip", None)
    module = model()
    precision = resolve_precision(config("bf16", accum=4), module, CUDA)
    assert precision.use_amp_autocast
    assert precision.amp_dtype == torch.bfloat16
    assert precision.accum == 4
    assert dtypes(module) == {torch.float32}


def test_bf16_on_rocm_casts_the_parameters(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(torch.version, "hip", "6.2")
    module = model()
    precision = resolve_precision(config("bf16"), module, CUDA)
    assert not precision.use_amp_autocast
    assert dtypes(module) == {torch.bfloat16}


def test_fp16_on_cuda_casts_the_parameters(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(torch.version, "hip", None)
    module = model()
    precision = resolve_precision(config("fp16"), module, CUDA)
    assert not precision.use_amp_autocast
    assert dtypes(module) == {torch.float16}


@pytest.mark.parametrize("setting", ["bf16", "fp32"])
def test_a_cpu_run_trains_in_fp32(setting: str) -> None:
    module = model()
    precision = resolve_precision(config(setting), module, CPU)
    assert not precision.use_amp_autocast
    assert dtypes(module) == {torch.float32}


def test_an_autocast_step_updates_fp32_weights_by_less_than_a_bf16_spacing() -> None:
    """An update a bf16 weight would round away still reaches an fp32 master weight under bf16 autocast."""
    module = torch.nn.Linear(1, 1, bias=False)
    with torch.no_grad():
        module.weight.fill_(1.0)
    optim = torch.optim.SGD(module.parameters(), lr=1e-4)
    with torch.autocast(device_type="cpu", dtype=torch.bfloat16):
        loss = module(torch.ones(1, 1)).sum()
    loss.backward()
    optim.step()
    # bf16 values near 1.0 are 2**-7 apart, so a bf16 weight would stay at exactly 1.0 after a 1e-4 step.
    assert module.weight.dtype == torch.float32
    assert module.weight.item() == pytest.approx(1.0 - 1e-4)
    assert torch.tensor(1.0 - 1e-4).bfloat16().item() == 1.0
