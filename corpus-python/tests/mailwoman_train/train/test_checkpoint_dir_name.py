"""The checkpoint directory name, which the writer and every reader now take from one function.

`save_checkpoint` zero-padded to six digits while `export_onnx` interpolated the step verbatim, so the invocation
`export_onnx`'s own docstring documented — `--step=60000` — raised FileNotFoundError against a directory named
`step-060000`. `--step=060000` worked.

A step reaches a Modal entry point as a string, so the name has to accept either spelling and produce the one the
writer used.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from mailwoman_train.train.checkpoint import CHECKPOINT_STEP_DIGITS, checkpoint_dir_name


def test_pads_to_the_width_the_writer_uses() -> None:
    assert checkpoint_dir_name(60000) == "step-060000"
    assert checkpoint_dir_name(500) == "step-000500"
    assert checkpoint_dir_name(0) == "step-000000"


@pytest.mark.parametrize("step", ["60000", "060000", 60000])
def test_every_spelling_of_a_step_resolves_the_same_directory(step: str | int) -> None:
    assert checkpoint_dir_name(step) == "step-060000"


def test_a_step_wider_than_the_pad_is_not_truncated() -> None:
    # Padding is a minimum width, never a format the value has to fit.
    assert checkpoint_dir_name(1_234_567) == "step-1234567"


def test_the_written_directory_is_the_one_the_name_predicts(tmp_path: Path) -> None:
    # The pairing this exists to hold: what `save_checkpoint` creates is what a reader composing the name finds.
    written = tmp_path / checkpoint_dir_name(60000)
    written.mkdir()

    assert (tmp_path / checkpoint_dir_name("60000")).is_dir()
    assert written.name == f"step-{60000:0{CHECKPOINT_STEP_DIGITS}d}"
