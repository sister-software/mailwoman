"""A row's `verifier` names its module and function as strings, so something has to resolve them.

A rename in the training package is otherwise found by a sync running in a container, after the
corpus is staged and with the operator waiting.
"""

from __future__ import annotations

import importlib

import pytest
from launch.corpora import CORPUS_VERSIONS

VERIFIED = sorted(version for version, entry in CORPUS_VERSIONS.items() if entry.verifier)


def test_some_version_carries_a_verifier() -> None:
    """Without this, every check below would pass over an empty list."""
    assert VERIFIED


@pytest.mark.parametrize("version", VERIFIED)
def test_the_verifier_resolves_and_answers_a_verdict_per_check(version: str, tmp_path) -> None:
    """The named function exists, takes the two roots, and answers `{what it means: whether it holds}`.

    Called against an EMPTY tree, so every answer must be False. A verifier that reports True on a
    volume holding nothing checks nothing.
    """
    module_name, function_name = CORPUS_VERSIONS[version].verifier
    module = importlib.import_module(module_name)
    verify = getattr(module, function_name, None)
    assert callable(verify), f"{module_name} has no callable {function_name!r}"

    checks = verify(str(tmp_path / "package"), str(tmp_path / "versioned"))

    assert checks, f"{module_name}.{function_name} checked nothing"
    assert all(isinstance(label, str) for label in checks), "each key must say what the check MEANS"
    assert not any(checks.values()), (
        f"these answered True against an empty tree: {sorted(k for k, v in checks.items() if v)}"
    )


def test_the_registries_verifier_delegates_to_each_country(tmp_path) -> None:
    """The region assembles; it does not restate. A restated Korean path passes every check a
    delegated one does, so nothing else would catch the drift back into one shared file."""
    from mailwoman_train.countries.cjk import staging as cjk
    from mailwoman_train.countries.jp import staging as jp
    from mailwoman_train.countries.kr import staging as kr
    from mailwoman_train.countries.tw import staging as tw

    versioned = str(tmp_path / "versioned")
    assembled = cjk.staged_registries(str(tmp_path / "package"), versioned)

    for country in (jp, kr, tw):
        own = country.staged(versioned)
        assert own, f"{country.__name__} claims no staged artifacts"
        missing = set(own) - set(assembled)
        assert not missing, f"{country.__name__} expectations the region drops: {sorted(missing)}"
