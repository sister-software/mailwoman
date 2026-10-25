"""Checks the launcher's pure decisions: bucket layout detection, resume points, run paths and settings."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from launch.plan import NESTED, NO_CHECK_BUCKET, STEADY, WIDE, WRAPPED, corpus, detect_layout
from launch.resume import check_clearable, resolve_run_paths, resume_point

from launch import settings as launch_settings


@pytest.fixture(autouse=True)
def _fresh_settings() -> Iterator[None]:
    launch_settings.reset_cache()
    yield
    launch_settings.reset_cache()


def test_a_corpus_pushed_whole_is_detected_as_nested() -> None:
    """`rclone copy <entry>/` leaves `corpus-<v>/` under the key, which must not land one directory too deep."""
    layout = detect_layout("v9-probe", ["corpus-v9-probe"])
    assert layout == NESTED
    copy = corpus("v9-probe", layout)
    assert copy.source == "corpus/v9-probe/corpus-v9-probe/"
    assert copy.destination == "corpus/versioned/v9-probe/corpus-v9-probe/"


def test_a_corpus_from_the_uploader_is_detected_as_wrapped() -> None:
    """`mailwoman corpus upload` sends the inner directory, so the key holds `train/`, `val/` and the MANIFEST."""
    layout = detect_layout("v9-probe", ["train", "val", "attributes"])
    assert layout == WRAPPED
    copy = corpus("v9-probe", layout)
    assert copy.source == "corpus/v9-probe/"
    assert copy.destination == "corpus/versioned/v9-probe/corpus-v9-probe/"


def test_another_versions_wrapper_is_not_mistaken_for_this_one() -> None:
    assert detect_layout("v9-probe", ["corpus-v9-probe-base"]) == WRAPPED


@pytest.mark.parametrize("flags", [WIDE, STEADY])
def test_every_transfer_skips_the_bucket_check(flags: str) -> None:
    assert NO_CHECK_BUCKET in flags.split()


def test_an_attempt_resumes_from_its_own_latest_checkpoint_over_the_branch_point() -> None:
    assert resume_point("/data/output-x/step-002000", "/data/output-base/step-030000") == "/data/output-x/step-002000"


def test_a_first_attempt_starts_from_the_branch_point_when_one_is_named() -> None:
    assert resume_point(None, "/data/output-base/step-030000") == "/data/output-base/step-030000"


def test_a_first_attempt_without_a_branch_point_starts_from_scratch() -> None:
    assert resume_point(None, "") is None


def test_run_paths_keep_a_mounted_output_dir_and_follow_its_log() -> None:
    paths = resolve_run_paths("/data/output-x/checkpoints", "{output_dir}/train_log.csv", "/data")
    assert paths.output_dir == "/data/output-x/checkpoints"
    assert paths.csv_log_path == "/data/output-x/checkpoints/train_log.csv"
    assert paths.run_base == "/data/output-x"


def test_run_paths_move_an_unmounted_output_dir_under_the_mount() -> None:
    paths = resolve_run_paths("out/checkpoints", "train_log.csv", "/vol")
    assert paths.output_dir == "/vol/output/checkpoints"
    assert paths.csv_log_path == "/vol/output/train_log.csv"


@pytest.mark.parametrize("directory", ["/data/output-x/checkpoints", "/data/models/checkpoints/stage1"])
def test_a_run_directory_is_clearable(directory: str) -> None:
    check_clearable(directory, "/data")


@pytest.mark.parametrize(
    "directory", ["/data", "/elsewhere/output-x", "/data/corpus/versioned/v1", "/data/models/tokenizer"]
)
def test_a_shared_directory_is_never_cleared(directory: str) -> None:
    with pytest.raises(ValueError, match="refusing to clear"):
        check_clearable(directory, "/data")


def test_settings_read_the_environment_over_the_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAILWOMAN_MODAL_TRAIN_GPU", "H100")
    monkeypatch.setenv("MAILWOMAN_VOLUME_MOUNT", "/vol")
    current = launch_settings.settings()
    assert current.train_gpu == "H100"
    assert launch_settings.container_env()["MAILWOMAN_SHA256_CACHE"] == "/vol/audits/sha256-cache.json"


def test_the_container_env_carries_no_credential(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RCLONE_S3_SECRET_ACCESS_KEY", "secret")
    assert not any(key.startswith("RCLONE_") for key in launch_settings.container_env())


def test_env_file_lines_parse_like_the_typescript_reader() -> None:
    parsed = launch_settings.parse_env_file('# c\nexport A=1\nB="two"\n\nC=\nD=x=y\n')
    assert parsed == {"A": "1", "B": "two", "C": "", "D": "x=y"}


def test_a_worktree_finds_the_main_checkouts_env(tmp_path: Path) -> None:
    main = tmp_path / "main"
    (main / ".git" / "worktrees" / "w").mkdir(parents=True)
    (main / ".git" / "worktrees" / "w" / "commondir").write_text("../..\n")
    (main / ".env").write_text("A=1\n")
    worktree = tmp_path / "w"
    worktree.mkdir()
    (worktree / ".git").write_text(f"gitdir: {main / '.git' / 'worktrees' / 'w'}\n")
    assert launch_settings._main_checkout_of(worktree) == main
