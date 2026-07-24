"""Strict-merge tests for #1248.

The 2026-07-22 en-GB probe run A burned a launch cycle on a YAML whose
``train.reinit_label_rows`` + ``train.classifier_learning_rate`` keys were silently
dropped by a volume-side config that predated them — the run proceeded as a plain
fine-tune with zero signal that its levers were inert. Config guards RAISE (same
discipline as the YAML-Norway guard in ``DataConfig.__post_init__``).
"""

from __future__ import annotations

import pytest

from mailwoman_train.config import Config, _merge, load_config


def _write(tmp_path, text: str):
    path = tmp_path / "probe.yaml"
    path.write_text(text, encoding="utf-8")
    return path


def test_unknown_nested_key_raises_with_dotted_path_and_file(tmp_path):
    path = _write(tmp_path, "train:\n  reinit_label_rowz: [B-dependent_locality]\n  max_steps: 10\n")
    with pytest.raises(KeyError) as excinfo:
        load_config(path)
    message = str(excinfo.value)
    # The full dotted path, so the offender is findable in a 100-line YAML…
    assert "train.reinit_label_rowz" in message
    # …and the config file it came from.
    assert "probe.yaml" in message


def test_unknown_top_level_section_raises(tmp_path):
    path = _write(tmp_path, "trian:\n  max_steps: 10\n")
    with pytest.raises(KeyError, match="trian"):
        load_config(path)


def test_strict_is_the_default_for_merge():
    cfg = Config()
    with pytest.raises(KeyError) as excinfo:
        _merge(cfg, {"train": {"classifier_learning_rates": 1e-4}})
    assert "train.classifier_learning_rates" in str(excinfo.value)


def test_known_keys_merge_unchanged(tmp_path):
    path = _write(
        tmp_path,
        "train:\n  max_steps: 123\n  reinit_label_rows: [B-dependent_locality]\n"
        "model:\n  hidden_size: 384\n"
        "data:\n  max_length: 96\n",
    )
    cfg = load_config(path)
    assert cfg.train.max_steps == 123
    assert cfg.train.reinit_label_rows == ["B-dependent_locality"]
    assert cfg.model.hidden_size == 384
    assert cfg.data.max_length == 96


def test_lenient_mode_preserves_the_silent_skip(tmp_path):
    # strict=False is the escape hatch for tooling that intentionally consumes a
    # partial view of a config: unknown keys are skipped, known keys still merge.
    path = _write(tmp_path, "train:\n  not_a_lever: 1\n  max_steps: 7\n")
    cfg = load_config(path, strict=False)
    assert cfg.train.max_steps == 7
    assert not hasattr(cfg.train, "not_a_lever")


def test_lenient_merge_skips_unknown_keys():
    cfg = Config()
    _merge(cfg, {"model": {"future_knob": True, "hidden_size": 512}}, strict=False)
    assert cfg.model.hidden_size == 512
    assert not hasattr(cfg.model, "future_knob")


def test_shipped_configs_all_load_under_strict():
    # The #1248 audit: every historical config in the repo must pass strict mode —
    # no grandfathering allowlist exists, so a junk key landing in any shipped YAML
    # fails here instead of at a Modal launch.
    from pathlib import Path

    configs_dir = Path(__file__).resolve().parent.parent.parent / "src" / "mailwoman_train" / "configs"
    paths = sorted(configs_dir.glob("*.yaml"))
    assert paths, f"no configs found under {configs_dir}"
    for path in paths:
        load_config(path)  # strict=True — raises on the first unknown key
