"""Checks the Rust launch's pure parts: the image's pins and data files, the command line and the console parsing."""

from __future__ import annotations

import hashlib

from launch.app import LIBTORCH_ARCHIVES, LIBTORCH_VERSION, TRAINER_DATA_FILES
from launch.settings import repository_root
from launch.train_rust import DEVICE_LINE, SAVE_LINE, STEP_LINE, staged_paths, trainer_command
from launch.wall_clock import estimate_wall_clock


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
    estimate = estimate_wall_clock("cpu", 200, 100)
    assert estimate.seconds_per_100_steps == 43.3
    assert estimate.evaluations == 3
