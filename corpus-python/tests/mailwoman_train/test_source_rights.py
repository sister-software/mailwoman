"""The Python reader of the corpus-source rights check, over the committed register and table.

The builders and the training launch call it before writing a row or billing a GPU, so a refusal here is the
whole defense on the Python side. It must refuse the source that carried Price Paid Data and a source nobody
mapped, and admit one whose every register row is elected for transform and train.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from mailwoman_train import source_rights
from mailwoman_train.config import admitted_sources, load_config, load_training_config
from mailwoman_train.corpora.deepseek import cli as deepseek_cli
from mailwoman_train.corpora.deepseek.cli import main as deepseek_main
from mailwoman_train.paths import package_path, repo_root_path
from mailwoman_train.source_rights import SourceRights, SourceRightsError, admit_sources, committed_source_rights


def test_rendered_gb_is_refused_on_the_price_paid_data_row() -> None:
    gaps = committed_source_rights().gaps("rendered-gb")
    ppd = [gap for gap in gaps if gap.register_source == "gb-property-building-1"]
    assert len(ppd) == 1
    assert ppd[0].state == "refused"
    assert ppd[0].missing == ("transform", "train")


def test_an_unmapped_source_is_refused() -> None:
    (gap,) = committed_source_rights().gaps("never-mapped-source")
    assert gap.register_source is None
    assert "no entry" in gap.because


def test_a_source_reading_only_elected_rows_is_admitted_under_either_spelling() -> None:
    rights = committed_source_rights()
    assert rights.gaps("ban") == []
    assert rights.gaps("fragment-fr") == []
    assert rights.gaps("synth-fr-fragment") == []


def test_the_refusal_names_the_source_the_row_and_the_permission() -> None:
    with pytest.raises(SourceRightsError, match=r"rendered-gb reads register source gb-property-building-1.*refused"):
        admit_sources(["ban", "rendered-gb"], context="test build")


def test_the_override_admits_and_marks_the_output_not_shippable(capsys: pytest.CaptureFixture[str]) -> None:
    record = admit_sources(["rendered-gb"], context="test build", unshippable_reason="local experiment")
    assert record.shippable is False
    assert record.unshippable_reason == "local experiment"
    assert "UNSHIPPABLE test build" in capsys.readouterr().err


def test_a_blank_override_is_refused() -> None:
    with pytest.raises(ValueError, match="must say why"):
        admit_sources(["ban"], context="test build", unshippable_reason="  ")


def _write_config(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "config.yaml"
    path.write_text(body, encoding="utf-8")
    return path


def test_training_config_admitting_rendered_gb_is_refused(tmp_path: Path) -> None:
    path = _write_config(tmp_path, "data:\n  source_weights:\n    ban: 1.0\n    rendered-gb: 6.0\n")
    with pytest.raises(SourceRightsError, match="gb-property-building-1"):
        load_training_config(path)


def test_a_zero_weight_declines_the_source(tmp_path: Path) -> None:
    path = _write_config(tmp_path, "data:\n  source_weights:\n    ban: 1.0\n    rendered-gb: 0.0\n")
    cfg, record = load_training_config(path)
    assert admitted_sources(cfg) == ["ban"]
    assert record.shippable is True


def test_a_config_without_source_weights_names_nothing_to_check(tmp_path: Path) -> None:
    path = _write_config(tmp_path, "data:\n  max_length: 64\n")
    with pytest.raises(SourceRightsError, match="sets no source_weights"):
        load_training_config(path)


def test_the_config_override_marks_the_run_not_shippable(tmp_path: Path) -> None:
    path = _write_config(
        tmp_path, "data:\n  unshippable_reason: local experiment\n  source_weights:\n    rendered-gb: 6.0\n"
    )
    _cfg, record = load_training_config(path)
    assert record.shippable is False
    assert record.unshippable_reason == "local experiment"


def test_the_published_models_config_is_refused_at_launch() -> None:
    """v7.2.0 trained the published model on rendered-gb, so its config cannot launch a shippable run."""
    path = package_path("configs", "v7.2.0-address-systems-60k.yaml")
    assert "rendered-gb" in admitted_sources(load_config(path))
    with pytest.raises(SourceRightsError, match="rendered-gb reads register source gb-property-building-1"):
        load_training_config(path)


def test_a_built_corpus_is_judged_by_the_inputs_that_built_it() -> None:
    """fragment-assay now reads only elected publishers, but v0.7.7-no-ppd holds rows read through the refused
    OpenAddresses collection, so a config training on that corpus cannot admit them."""
    rights = committed_source_rights()
    assert rights.gaps("fragment-assay") == []
    stale = rights.gaps("fragment-assay", "v0.7.7-no-ppd")
    assert [gap.register_source for gap in stale] == ["us-geodata-aggregate-3"]
    with pytest.raises(SourceRightsError, match="fragment-assay reads register source us-geodata-aggregate-3"):
        load_training_config(package_path("configs", "v7.7.0-no-ppd-60k.yaml"))


def test_a_corpus_builder_refuses_before_it_reads_a_key_or_writes_a_row(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The builder checks rights before it reads an API key.

    The committed DeepSeek decision is elected, so the test refuses that row in a copy of the register. A builder
    that reads the API key fails the test, because a builder that got that far would bill the DeepSeek API.
    """
    data = repo_root_path("packages", "corpus", "data")
    register = json.loads((data / "address-source-register.json").read_text(encoding="utf-8"))
    table = json.loads((data / "corpus-source-inputs.json").read_text(encoding="utf-8"))
    license_id = next(row["license"] for row in register["sources"] if row["sourceID"] == "cn-generated-text-1")
    for decision in register["licenses"]:
        if decision["licenseID"] == license_id:
            decision["state"] = "refused"
    monkeypatch.setattr(source_rights, "committed_source_rights", lambda: SourceRights.from_documents(register, table))

    def refuse_key() -> str:
        raise AssertionError("the builder read the DeepSeek API key before the rights check refused it")

    monkeypatch.setattr(deepseek_cli, "require_api_key", refuse_key)

    out_dir = tmp_path / "out"
    with pytest.raises(SourceRightsError, match="deepseek-kryptonite reads register source cn-generated-text-1"):
        deepseek_main(["--mode", "kryptonite", "--out-dir", str(out_dir)])
    assert not out_dir.exists()
