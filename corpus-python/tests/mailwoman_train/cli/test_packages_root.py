"""The weights-bundle destination is the checkout's own `packages/`, or a raised error.

The previous implementation counted five parent hops from `cli.py` to the repo root and fell back
to a relative `Path("packages")` when that missed. It missed: the file sits four hops down, so the
search landed above the checkout, and `package` wrote its bundles under the working directory
instead — the wrong place, reported as success.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from mailwoman_train.cli.packages_root import find_packages_root


def test_it_finds_the_checkout_packages_directory() -> None:
    found = find_packages_root()

    assert found.is_absolute(), "a relative answer resolves against the working directory"
    assert found.is_dir()
    assert found.name == "packages"
    assert (found.parent / "package.json").is_file(), "the parent must be the repo root"


def test_it_answers_the_root_that_holds_this_file() -> None:
    found = find_packages_root()
    here = Path(__file__).resolve()

    assert found.parent in here.parents, f"{found.parent} is not above {here}"


def test_it_raises_rather_than_answering_a_relative_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """With no qualifying parent the function must raise, not hand back somewhere writable."""
    from mailwoman_train.cli import packages_root

    monkeypatch.setattr(packages_root, "__file__", "/nonexistent/src/mailwoman_train/cli/packages_root.py")

    with pytest.raises(RuntimeError, match="no repository root"):
        find_packages_root()
