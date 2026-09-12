"""The launcher's entry point: the one file `modal run` is pointed at.

    cd corpus-python
    modal run -m launch.train_remote::<name> [--flag value ...]

MODULE MODE, not a file path. Modal imports a file path as a TOP-LEVEL module with the file's own
directory on `sys.path`, which makes `launch` unimportable and every `from .x import y` in this
package an ImportError; `-m` imports it as `launch.train_remote` with the package intact. The
launcher is a package because a single file grew to fifty-seven near-identical sync functions and
three thousand lines, and nobody could answer what it staged without reading all of them.

A GPU run is DETACHED and never started from a shell directly — a `modal run` is a local client
whose death cancels the remote input, so a harness that kills the client loses the run:

    node packages/mailwoman/lib/dev-tools/launch-detached.run.ts --log <file> --cwd corpus-python \\
      -- modal run -d -m launch.train_remote --config <recipe>.yaml --resume auto

What lives where:

| module         | what it owns                                                            |
| -------------- | ----------------------------------------------------------------------- |
| `app.py`       | the one `modal.App`, the image with its pinned toolchain, the secrets     |
| `plan.py`      | turning a table row into transfers and paths — pure, no Modal             |
| `corpora.py`   | the table: one row per corpus version, what it stages and verifies        |
| `syncs.py`     | `sync` (a named row) and `sync_assets` (paths on the command line)        |
| `stage.py`     | staging from a local mount, for when the bucket answers 401               |
| `train.py`     | the A100 run, its preflights, and the `main` entry point                  |
| `artifacts.py` | ONNX export, int8 quantization, and pushing an artifact back to R2         |
| `splices.py`   | the splice table: which checkpoint grows onto which tokenizer             |
| `mean_init.py` | running one splice                                                        |
| `grade.py`     | scoring a checkpoint: per-tag readouts and feature ON/OFF contrasts        |
| `audits.py`    | the training package's own audits, run on the volume, receipt committed    |
| `census.py`    | counting what the corpus teaches, to settle an open question              |
| `volume.py`    | what the container sees and what the image actually holds                 |

This file defines nothing. It imports each module so that the one `app` carries every function,
because `modal run -m launch.train_remote::<name>` resolves `<name>` against THIS module's
namespace — a function whose module is never imported is a function nobody can launch.
"""

from __future__ import annotations

from .app import app
from .artifacts import export_onnx, push_artifact_r2, quantize_onnx
from .audits import audit_epoch_mixture, audit_suffix_feed, census_opening_token
from .census import country_census_raw, diagnose_corpus, digit_prior, piece_prior
from .grade import diagnose_suffix_plasticity, eval_de, grade_evidence_bundle, grade_street_type_contrast
from .mean_init import mean_init
from .stage import stage_v8cjk_regs
from .syncs import sync, sync_assets

# `_train_gpu` is private because `main` is the way in — it preflights the receipts first. It is
# imported anyway so `::_train_gpu` still resolves, which is how a run is relaunched when the
# preflight has already passed and only the GPU leg needs repeating.
from .train import _train_gpu, main, preflight_corpus_receipts
from .volume import debug_volume, run_tests, versions

__all__ = [
    "_train_gpu",
    "app",
    "audit_epoch_mixture",
    "audit_suffix_feed",
    "census_opening_token",
    "country_census_raw",
    "debug_volume",
    "diagnose_corpus",
    "diagnose_suffix_plasticity",
    "digit_prior",
    "eval_de",
    "export_onnx",
    "grade_evidence_bundle",
    "grade_street_type_contrast",
    "main",
    "mean_init",
    "piece_prior",
    "preflight_corpus_receipts",
    "push_artifact_r2",
    "quantize_onnx",
    "run_tests",
    "stage_v8cjk_regs",
    "sync",
    "sync_assets",
    "versions",
]
