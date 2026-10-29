"""The current loader reproduces the Python encoder's recorded tensors on the 2,000-row C6 sample.

The record (`audits/encoder-parity/c6-train-2k/` under the data root) was captured from the Python encoder before the
Rust encoder replaced it. It re-roots the config's `/data` paths and names its lexicons with host overrides, so this
test runs on a host that holds the record and every input it names, and skips with the reason elsewhere. The other
records of the matrix are verified with the same tool (`python -m mailwoman_train.audits.encoder_parity verify`).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from mailwoman_train.audits.encoder_parity import prepare_config, record_dir, recorded_config_path, verify
from mailwoman_train.env import MissingEnvironmentError

try:
    RECORD = record_dir("c6-train-2k")
    _SKIP = None if (RECORD / "record.json").is_file() else f"the parity record is absent at {RECORD}"
except MissingEnvironmentError:
    _SKIP = "MAILWOMAN_DATA_ROOT is unset, so the parity record cannot be located"


@pytest.mark.skipif(_SKIP is not None, reason=_SKIP or "")
def test_the_loader_reproduces_the_recorded_python_encoding() -> None:
    record = json.loads((RECORD / "record.json").read_text(encoding="utf-8"))
    missing = [v["path"] for v in record["inputs"].values() if not Path(v["path"]).is_file()]
    if missing:
        pytest.skip(f"the record's inputs are absent on this host: {missing}")
    cfg = prepare_config(recorded_config_path(record), record["config"]["overrides"])
    report = verify(record, cfg, out_dir=RECORD)
    assert report["structural"] == []
    assert report["changed_inputs"] == {}
    assert report["differing_rows"] == 0, report["first_mismatch"]
    assert report["emitted_rows"] == record["emitted_rows"] == 2000
