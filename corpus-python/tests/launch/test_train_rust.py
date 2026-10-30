"""Checks the Rust launch's pure parts: the image's pins and data files, the command line and the console parsing."""

from __future__ import annotations

import hashlib
import json
from types import SimpleNamespace

import launch.train
import launch.train_rust as train_rust
import pytest
from launch.app import LIBTORCH_ARCHIVES, LIBTORCH_VERSION, TRAINER_DATA_FILES
from launch.run_lock import DuplicateLaunchError
from launch.settings import repository_root
from launch.train_rust import (
    DEVICE_LINE,
    SAVE_LINE,
    STEP_LINE,
    LaunchRefusal,
    attempt,
    check_staged_launch,
    staged_paths,
    trainer_command,
)
from launch.wall_clock import estimate_wall_clock

LAUNCH = {"config_sha256": "abc", "output_dir": "/data/output-a/checkpoints", "audits": "", "run_base": "/data/a"}
RESOLVED = {"config_sha256": "abc", "config": {"train": {"output_dir": "/data/output-a/checkpoints"}}}


def test_a_staged_launch_that_matches_passes() -> None:
    check_staged_launch(RESOLVED, LAUNCH, "/r.json", "/c.yaml")


@pytest.mark.parametrize(
    ("resolved", "launch", "message"),
    [
        (RESOLVED, {"refused": "no preflight receipt"}, "no preflight receipt"),
        ({**RESOLVED, "config_sha256": "other"}, LAUNCH, "does not describe /c.yaml"),
        ({**RESOLVED, "config": {"train": {"output_dir": "/mnt/x"}}}, LAUNCH, "resolved output_dir /mnt/x"),
    ],
)
def test_a_host_detectable_mismatch_is_a_launch_refusal(
    resolved: dict[str, object], launch: dict[str, str], message: str
) -> None:
    with pytest.raises(LaunchRefusal, match=message):
        check_staged_launch(resolved, launch, "/r.json", "/c.yaml")


class _Function:
    """A stub of a Modal function: `remote` answers ``result`` and `spawn` counts its calls."""

    def __init__(self, result: object = None) -> None:
        self.result = result
        self.spawned = 0

    def remote(self, *args: object, **kwargs: object) -> object:
        return self.result

    def with_options(self, **kwargs: object) -> _Function:
        return self

    def spawn(self, *args: object) -> SimpleNamespace:
        self.spawned += 1
        return SimpleNamespace(object_id="fc-stub", get_dashboard_url=lambda: "")


def test_a_stale_receipt_spawns_no_training_call(monkeypatch: pytest.MonkeyPatch) -> None:
    gpu = _Function()
    monkeypatch.setattr(train_rust, "resolve_on_host", lambda config: ("c.yaml", b"", json.dumps(RESOLVED)))
    monkeypatch.setattr(train_rust, "stage_launch_inputs", _Function({"config_path": "/c", "resolved_path": "/r"}))
    monkeypatch.setattr(launch.train, "preflight", _Function("token"))
    monkeypatch.setattr(train_rust, "verify_launch", _Function({"refused": "the receipt is stale"}))
    monkeypatch.setattr(train_rust, "_train_rust_gpu", gpu)
    with pytest.raises(LaunchRefusal, match="the receipt is stale"):
        train_rust.launch_rust("c.yaml", False, "", "A100-80GB", False, 0, 0, 0, -1)
    assert gpu.spawned == 0


@pytest.mark.parametrize("error", [LaunchRefusal("wrong device"), DuplicateLaunchError("fc-1 holds the lock")])
def test_a_deterministic_refusal_returns_instead_of_raising(monkeypatch: pytest.MonkeyPatch, error: Exception) -> None:
    def refuse(*args: object) -> None:
        raise error

    monkeypatch.setattr(train_rust, "_run_trainer", refuse)
    assert attempt("/c", "/r", "t", "", 0, 0, "Cuda") == {"refused": str(error)}


def test_a_device_the_container_lacks_is_a_launch_refusal(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    def run(command: list[str], **kwargs: object) -> SimpleNamespace:
        calls.append(command)
        return SimpleNamespace(returncode=2, stdout="device=Cpu has_cuda=false\n", stderr="the run expects device cuda")

    monkeypatch.setattr(train_rust.subprocess, "run", run)
    with pytest.raises(LaunchRefusal, match="the run expects device cuda"):
        train_rust.check_device("Cuda")
    assert calls == [["trainer", "device", "--device", "cuda"]]


def test_a_transient_failure_raises_so_modal_retries_it(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail(*args: object) -> None:
        raise RuntimeError("trainer train exited -9")

    monkeypatch.setattr(train_rust, "_run_trainer", fail)
    with pytest.raises(RuntimeError, match="exited -9"):
        attempt("/c", "/r", "t", "", 0, 0, "Cuda")


def test_the_image_copies_every_data_file_the_trainer_reads() -> None:
    """`DataFiles::in_repository` lists the files. The image must copy each, or `trainer train` fails on Modal."""
    source = (repository_root() / "packages/trainer/crates/trainer-loop/src/config.rs").read_text()
    for relative in TRAINER_DATA_FILES:
        assert (repository_root() / relative).is_file(), relative
        assert relative.split("/")[-1] in source, relative


def test_the_cpu_archive_digest_is_the_one_ci_checks() -> None:
    workflow = (repository_root() / ".github/workflows/test.yml").read_text()
    assert f"libtorch-shared-with-deps-{LIBTORCH_VERSION}%2Bcpu.zip" in workflow
    assert f"{LIBTORCH_ARCHIVES['cpu']}  $RUNNER_TEMP/libtorch.zip" in workflow


def test_the_trainer_command_resumes_automatically() -> None:
    assert trainer_command("/data/launch/x/resolved.json", "auto", 0) == [
        "trainer",
        "train",
        "/data/launch/x/resolved.json",
        "--resume",
        "auto",
    ]
    assert trainer_command("/r.json", "/data/output-a/checkpoints/step-000100", 4)[-2:] == ["--threads", "4"]


def test_the_console_lines_the_wrapper_reads() -> None:
    step = STEP_LINE.match("step 150/200  train_loss=2.4798  lr=0.000089  rate=0.97 steps/s")
    assert step is not None and step.group(1) == "150"
    assert STEP_LINE.match("  [eval] val_loss=2.2251") is None
    assert SAVE_LINE.search("  [save] checkpoint → /data/output-a/checkpoints/step-000100")
    for line, device in (("device=Cpu param_count=29,640,663", "Cpu"), ("device=Cuda(0) param_count=1", "Cuda")):
        match = DEVICE_LINE.match(line)
        assert match is not None and match.group(1) == device


def test_staged_inputs_are_keyed_by_the_config_sha256() -> None:
    digest = hashlib.sha256(b"train: {}\n").hexdigest()
    config, resolved = staged_paths("f4.yaml", digest)
    assert config == f"/data/launch/{digest[:16]}/f4.yaml"
    assert resolved == f"/data/launch/{digest[:16]}/resolved.json"


def test_the_cpu_device_has_a_dev_rate() -> None:
    estimate = estimate_wall_clock("cpu", 200, 100, 8)
    assert estimate.seconds_per_100_steps == 43.3
    assert estimate.evaluations == 3
