# `corpus-python` Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `corpus-python/` from 48 flat modules plus a 5,278-line launcher into role directories at the package root with `countries/<cc>/` for country-specific code, adding declared protocols and training callbacks.

**Architecture:** Follow `packages/corpus/lib` — role directories hold cross-country code, and the same role names nest under a country key for country-specific code. Value types move to a package-root `types.py` so the tokenizer/alignment cycle disappears. The Modal launcher becomes a package driven by a table instead of 57 cloned functions, which forces a rename off `modal/` because that directory shadows the Modal SDK once it is importable.

**Tech Stack:** Python 3.12, `uv`, pytest, ruff 0.16.5, mypy strict, bandit, PyTorch 2.12.0, Modal.

**Spec:** `docs/superpowers/specs/2026-09-12-corpus-python-layout-design.md`

## Global Constraints

- Every command runs from `corpus-python/` unless the step says otherwise.
- Run tests with `uv run --extra dev --extra train pytest tests -q`. The baseline is **983 passed, 11 skipped** in ~30 s. A task is not done below 983.
- Never launch a training run. No step in this plan calls `modal run` against a GPU function.
- Source lives under `src/mailwoman_train/`; tests mirror it under `tests/mailwoman_train/`.
- Acronyms capitalize as whole components in identifiers: `parseJSON`, not `parseJson`. Python `snake_case` keeps its own convention (`onnx_path`), but a class is `ONNXExporter`, not `OnnxExporter`.
- `uvx ruff@0.16.5 check --fix .` and `uvx ruff@0.16.5 format .` after every move; ruff's `I` rule re-sorts imports and will otherwise fail CI.
- A comment states an invariant, a constraint, or why an obvious implementation is unsafe. Move history to the commit message. When moving a docstring that carries a measured number, the number travels with it.
- No module in `src/mailwoman_train/` exceeds 500 lines; no function exceeds 120.
- Commit after every task. Use `--no-verify` only when the pre-commit hook's Node half is unavailable in the worktree.

---

## File Structure

Target, from spec §6 and §8.2:

```
corpus-python/
├── src/mailwoman_train/
│   ├── types.py           PieceSpan and shared value types
│   ├── protocols.py       declared interfaces
│   ├── labels.py          stays at root (55 importers)
│   ├── config/            schema.py, load.py
│   ├── cli/commands/      one file per subcommand
│   ├── data/              loader, manifest, sources, encode, collate, augment,
│   │                      relabel, emit, masking, dose
│   ├── text/              kana.py, normalize.py
│   ├── tokenizer/         __init__.py, char.py, splice.py, train.py
│   ├── features/          gazetteer_anchor, country_lexicon, phrase_priors,
│   │                      postcode_shapes, conventions
│   ├── nn/                encoder, blocks, char_cnn, heads, crf, span_scorer, serialization
│   ├── optim/             schedules, groups, fisher
│   ├── train/             trainer.py, noise.py, checkpoint.py, pretrain.py, callbacks/
│   ├── eval/              metrics.py, evaluate.py
│   ├── export/            onnx.py, quantize.py, package_weights.py
│   ├── corpora/           builder.py, fragment.py, secondary.py, registry.py
│   ├── audits/            epoch_mixture, mixed_script, suffix_feed, opening_token
│   ├── observability/     trackio.py
│   └── countries/         jp/, kr/, tw/, cjk/
├── launch/                was modal/
└── scripts/verify_toolchain.py   the only survivor
```

---

## Task 1: `types.py` and the import cycle

**Files:**
- Create: `src/mailwoman_train/types.py`
- Modify: `src/mailwoman_train/tokenizer.py:54-59` (remove `PieceSpan`), `:541,550,566,583,598` (lift the deferred imports)
- Modify: `src/mailwoman_train/gazetteer_anchor.py:28`, `src/mailwoman_train/country_lexicon.py:39`
- Test: `tests/mailwoman_train/test_import_hygiene.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `mailwoman_train.types.PieceSpan`, a frozen-field dataclass with `piece: str`, `piece_id: int`, `char_begin: int`, `char_end: int`. Every later task imports `PieceSpan` from `mailwoman_train.types`, never from `mailwoman_train.tokenizer`.

The five deferred imports carry a comment claiming they keep `tokenizer.py` import-light. Verify that claim before removing them: `gazetteer_anchor.py` imports `json`, `re`, `collections.abc.Sequence`, `dataclasses.dataclass` and `.tokenizer`; `country_lexicon.py` imports `collections.abc.Sequence`, `.gazetteer_anchor` and `.tokenizer`. Neither reaches torch or any heavy dependency, so lifting them to module level costs nothing. Step 1 measures this rather than trusting the comment.

- [ ] **Step 1: Measure the import weight claim**

```bash
uv run python -X importtime -c "import mailwoman_train.tokenizer" 2>&1 | tail -1
uv run python -X importtime -c "import mailwoman_train.gazetteer_anchor, mailwoman_train.country_lexicon" 2>&1 | tail -1
```

Record both cumulative microsecond figures in the task's commit message. If the second is more than 50 ms above the first, stop and report — the comment's claim would then be real and the design needs revisiting.

- [ ] **Step 2: Write the failing test**

Create `tests/mailwoman_train/test_import_hygiene.py`:

```python
"""A deferred intra-package import may not dodge an import cycle.

A deferred import is legitimate when it buys startup weight: `cli.py` defers 32 of them and keeps
torch's 1.46 s off every `--help` (measured — `mailwoman_train.cli` imports in 22,340 us against
`mailwoman_train.train`'s 1,458,740 us). It is a defect when the target module imports this one back,
because then the deferral is hiding a circular graph and an ImportError surfaces at first call
rather than at import. This detector flags the second and leaves the first alone.
"""

from __future__ import annotations

import ast
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[2] / "src" / "mailwoman_train"


def _module_name(path: Path) -> str:
    relative = path.relative_to(SOURCE_ROOT).with_suffix("")
    parts = [p for p in relative.parts if p != "__init__"]
    return ".".join(["mailwoman_train", *parts])


def _resolve(module: str | None, level: int, holder: str) -> str:
    if level == 0:
        return module or ""
    base = holder.split(".")
    anchor = base[: len(base) - level + 1] if level > 1 else base[:-1] or base
    return ".".join([*anchor, module]) if module else ".".join(anchor)


def _imports(tree: ast.AST, holder: str, *, deferred: bool) -> set[tuple[str, int]]:
    """Every intra-package target imported at module level (deferred=False) or in a body (True)."""
    found: set[tuple[str, int]] = set()
    bodies = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef)]
    inside = {id(n) for body in bodies for n in ast.walk(body)}
    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom):
            continue
        if (id(node) in inside) is not deferred:
            continue
        target = _resolve(node.module, node.level, holder)
        if target.startswith("mailwoman_train"):
            found.add((target, node.lineno))
    return found


def _module_level_graph() -> dict[str, set[str]]:
    graph: dict[str, set[str]] = {}
    for path in sorted(SOURCE_ROOT.rglob("*.py")):
        holder = _module_name(path)
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        graph[holder] = {t for t, _ in _imports(tree, holder, deferred=False)}
    return graph


def _reaches(graph: dict[str, set[str]], start: str, goal: str) -> bool:
    seen: set[str] = set()
    stack = list(graph.get(start, ()))
    while stack:
        current = stack.pop()
        if current == goal:
            return True
        if current in seen:
            continue
        seen.add(current)
        stack.extend(graph.get(current, ()))
    return False


def test_no_deferred_import_dodges_a_cycle() -> None:
    graph = _module_level_graph()
    offenders: list[str] = []
    for path in sorted(SOURCE_ROOT.rglob("*.py")):
        holder = _module_name(path)
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for target, lineno in sorted(_imports(tree, holder, deferred=True)):
            if _reaches(graph, target, holder):
                offenders.append(f"{path.relative_to(SOURCE_ROOT)}:{lineno} defers {target}, which imports back")
    assert offenders == [], "deferred imports dodging a cycle:\n" + "\n".join(offenders)


def test_piece_span_is_declared_in_types() -> None:
    from mailwoman_train import types

    assert set(types.PieceSpan.__dataclass_fields__) == {
        "piece",
        "piece_id",
        "char_begin",
        "char_end",
    }
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
uv run --extra dev --extra train pytest tests/mailwoman_train/test_import_hygiene.py -q
```

Expected: both tests FAIL. The first lists exactly the five `tokenizer.py` sites at lines 541, 550, 566, 583 and 598 — and nothing else. The second fails with `ModuleNotFoundError: No module named 'mailwoman_train.types'`.

If the first test names more than those five, the cycle reachability walk is over-reaching; read the extra entries before weakening the assertion. If it names fewer, the walk is under-reaching and the detector is worthless — a false negative here is indistinguishable from a clean tree.

- [ ] **Step 4: Create `types.py`**

```python
"""Shared value types.

These live apart from the modules that produce them so a consumer can name a type without importing
the machinery. `PieceSpan` sat in `tokenizer.py`, which made `tokenizer` and the alignment modules
import each other and forced five function-body imports to dodge the cycle.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class PieceSpan:
    """One SentencePiece piece with its character offsets into the original `raw` string."""

    piece: str
    piece_id: int
    #: Inclusive begin, exclusive end.
    char_begin: int
    char_end: int
```

- [ ] **Step 5: Repoint every `PieceSpan` importer**

Delete the `PieceSpan` dataclass from `tokenizer.py:54-59` and add `from .types import PieceSpan` to its module-level imports. Then:

```bash
grep -rln 'from \.tokenizer import.*PieceSpan\|from mailwoman_train\.tokenizer import.*PieceSpan' src tests scripts
```

For each file the grep names, change the specifier to `.types` (or `mailwoman_train.types`). `gazetteer_anchor.py:28` and `country_lexicon.py:39` are the two in `src/`.

- [ ] **Step 6: Lift the five deferred imports to module level**

In `tokenizer.py`, add to the module-level imports:

```python
from .country_lexicon import COUNTRY_FEATURE_DIM, realign_country_to_pieces
from .gazetteer_anchor import realign_gazetteer_to_pieces, suppress_gazetteer_near_postcode
```

Then delete the six `from .` lines inside `encode_with_features` at 541, 550, 566, 583 and 598, along with the two comment lines that explain the deferral ("Local import keeps tokenizer.py import-light…"). Leave every other comment in that function in place — they describe channel behavior, not imports.

- [ ] **Step 7: Run the new test and the full suite**

```bash
uv run --extra dev --extra train pytest tests/mailwoman_train/test_import_hygiene.py -q
uv run --extra dev --extra train pytest tests -q
```

Expected: the hygiene test PASSES, and the suite reports at least **984 passed** (983 plus the two new tests, minus none).

- [ ] **Step 8: Lint, type-check, commit**

```bash
uvx ruff@0.16.5 check --fix . && uvx ruff@0.16.5 format .
uv run mypy
git add -A
git commit -m "refactor(train): move PieceSpan to types.py and remove the deferred imports"
```

---

## Task 2: `text/` and `corpora/builder.py`

**Files:**
- Create: `src/mailwoman_train/text/__init__.py`, `text/kana.py`, `text/normalize.py`
- Create: `src/mailwoman_train/corpora/__init__.py`, `corpora/builder.py`
- Modify: `src/mailwoman_train/build_jp_slice.py`, `build_tw_slice.py:59-69`, `build_kr_slice.py:52-63`, `build_cjk_overlay.py:46`, `build_registry_corpus.py:34-37`, `jp_registry.py:32`, `tw_registry.py:29`
- Test: `tests/mailwoman_train/test_text_normalize.py`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `mailwoman_train.text.kana`: `fold_halfwidth_kana(text: str) -> str`, `kanji_to_int(text: str) -> int | None`
  - `mailwoman_train.text.normalize`: `norm_key(text: str) -> str`, `ascii_digits(text: str) -> str`, `normalize_text(text: str) -> str`
  - `mailwoman_train.corpora.builder`: `SCHEMA`, `RowRenderer`, `MAX_FIELD_CHARS`, `MAX_RENDERED_CHARS`, `coverage_stats`, `muni_bucket`, `select_exact`, `verify_record`, `water_fill`
  - JP-only names stay JP-only and move in Task 13: `JP_PREFECTURES`, `normalize_name`, `normalize_number`, `split_street`.

This is the measured boundary — every name that crosses a builder today:

| Importer | Takes from | Names |
| --- | --- | --- |
| `jp_registry.py:32` | `build_jp_slice` | `JP_PREFECTURES`, `normalize_name`, `split_street` |
| `build_tw_slice.py:59` | `build_jp_slice` | `MAX_FIELD_CHARS`, `SCHEMA`, `RowRenderer`, `coverage_stats`, `muni_bucket`, `norm_key`, `select_exact`, `verify_record`, `water_fill` |
| `build_kr_slice.py:53` | `build_jp_slice` | the same nine plus `MAX_RENDERED_CHARS`, minus `verify_record` |
| `build_cjk_overlay.py:46` | `build_jp_slice` | `MAX_RENDERED_CHARS`, `SCHEMA` |
| `build_registry_corpus.py:35` | `build_jp_slice` | `BOARD_BUCKET_MIN`, `SCHEMA`, `coverage_stats`, `muni_bucket`, `norm_key`, `select_exact` |
| `tw_registry.py:29` | `build_tw_slice` | `ascii_digits`, `normalize_text` |
| `build_kr_slice.py:52`, `build_registry_corpus.py:34` | `build_cjk_overlay` | `verify_cn_record` |

`BOARD_BUCKET_MIN` does NOT move. It is 90 in `build_tw_slice.py` and a different value in `build_jp_slice.py`; the two importers alias it apart (`JP_BOARD_BUCKET_MIN`, `TW_BOARD_BUCKET_MIN`). It is a per-country constant and stays with its country in Task 13.

- [ ] **Step 1: Write the failing test**

Create `tests/mailwoman_train/test_text_normalize.py`:

```python
"""The shared CJK text helpers answer from `text/`, not from a corpus builder."""

from __future__ import annotations

from mailwoman_train.text.kana import fold_halfwidth_kana, kanji_to_int


def test_fold_halfwidth_kana_folds_halfwidth_to_fullwidth() -> None:
    assert fold_halfwidth_kana("ｶﾀｶﾅ") == "カタカナ"


def test_fold_halfwidth_kana_leaves_prolonged_sound_mark_alone() -> None:
    # U+30FC is a real katakana character inside a place name; folding it to "-" corrupts the name.
    assert fold_halfwidth_kana("コーヒー") == "コーヒー"


def test_kanji_to_int_reads_a_chome_numeral() -> None:
    assert kanji_to_int("二") == 2


def test_kanji_to_int_answers_none_for_a_non_numeral() -> None:
    assert kanji_to_int("字") is None


def test_builder_machinery_answers_from_corpora() -> None:
    from mailwoman_train.corpora.builder import SCHEMA, RowRenderer

    assert SCHEMA is not None
    assert RowRenderer is not None
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
uv run --extra dev --extra train pytest tests/mailwoman_train/test_text_normalize.py -q
```

Expected: FAIL with `ModuleNotFoundError: No module named 'mailwoman_train.text'`.

- [ ] **Step 3: Create the two packages**

`src/mailwoman_train/text/__init__.py`:

```python
"""Script-level text normalization, shared across countries.

A corpus builder is not a home for a helper five modules need. These names lived in
`build_jp_slice.py`, which made a government-register reader import a corpus builder.
"""
```

`src/mailwoman_train/corpora/__init__.py`:

```python
"""Corpus construction: the shared row machinery and the country-agnostic builders."""
```

- [ ] **Step 4: Move the text helpers**

Cut `fold_halfwidth_kana` (`build_jp_slice.py:178`) and `kanji_to_int` (`:212`) into `text/kana.py`, with their docstrings and any module-level regex or table they reference. Cut `norm_key` from `build_jp_slice.py` and `ascii_digits` plus `normalize_text` from `build_tw_slice.py` into `text/normalize.py`.

Carry each docstring verbatim. `normalize_name`'s docstring holds a measured number ("coverage read 1.000001, which is how a six-row defect announces itself") — that function stays in `build_jp_slice.py` for now and moves in Task 13, docstring intact.

- [ ] **Step 5: Move the builder machinery**

Cut `SCHEMA`, `RowRenderer`, `MAX_FIELD_CHARS`, `MAX_RENDERED_CHARS`, `coverage_stats`, `muni_bucket`, `select_exact`, `verify_record` and `water_fill` from `build_jp_slice.py` into `corpora/builder.py`. Cut `verify_cn_record` from `build_cjk_overlay.py` into the same file.

`build_kr_slice.py:52` aliases `verify_cn_record` as `verify_record` on import while `build_tw_slice.py` imports a different `verify_record` from `build_jp_slice`. Both names now live in `corpora/builder.py`, so keep the alias at the Korean call site and do not merge the two functions.

- [ ] **Step 6: Repoint every importer**

```bash
grep -rn 'from \.build_jp_slice import\|from \.build_tw_slice import\|from \.build_cjk_overlay import' src
```

Rewrite each to name `.text.kana`, `.text.normalize` or `.corpora.builder` per the table above. `jp_registry.py:32` keeps `JP_PREFECTURES, normalize_name, split_street` on `.build_jp_slice` until Task 13.

- [ ] **Step 7: Run the suite**

```bash
uv run --extra dev --extra train pytest tests -q
```

Expected: at least **989 passed** (984 from Task 1 plus the five new tests).

- [ ] **Step 8: Lint, type-check, commit**

```bash
uvx ruff@0.16.5 check --fix . && uvx ruff@0.16.5 format .
uv run mypy
git add -A
git commit -m "refactor(train): give the shared CJK text helpers and row machinery a home"
```

---

## Task 3: The role directories

**Files:**
- Create: `src/mailwoman_train/{config,data,tokenizer,features,nn,optim,train,eval,export,audits,observability}/__init__.py`
- Move: 30 modules, listed per group below
- Test: no new test; the existing 989 are the check

**Interfaces:**
- Consumes: `mailwoman_train.types` (Task 1), `mailwoman_train.text.*` and `mailwoman_train.corpora.builder` (Task 2).
- Produces: every module reachable at its new dotted path. No public function signature changes.

Move in dependency order so each group's importers are already settled. `labels.py` has 55 importers and stays at the package root; `types.py` and `protocols.py` join it there.

| Group | From | To |
| --- | --- | --- |
| config | `config.py` | `config/schema.py` (the five dataclasses, lines 17-494) + `config/load.py` (`_merge`, `_coerce`, `load_config`, `csv_log_path`) |
| data | `data_loader.py` | `data/loader.py` |
| data | `augment.py`, `relabel.py`, `emit.py`, `masking.py`, `dose.py` | `data/<same>.py` |
| tokenizer | `tokenizer.py` | `tokenizer/__init__.py` |
| tokenizer | `char_tokenizer.py`, `tokenizer_splice.py`, `tokenizer_train.py` | `tokenizer/char.py`, `tokenizer/splice.py`, `tokenizer/train.py` |
| features | `gazetteer_anchor.py`, `country_lexicon.py`, `phrase_priors.py`, `postcode_shapes.py`, `conventions.py` | `features/<same>.py` |
| nn | `model.py` | `nn/encoder.py` |
| nn | `crf.py`, `span_scorer.py` | `nn/<same>.py` |
| optim | `fisher.py` | `optim/fisher.py` |
| train | `train.py`, `pretrain.py` | `train/trainer.py`, `train/pretrain.py` |
| eval | `eval.py` | `eval/evaluate.py` |
| export | `export_onnx.py`, `quantize.py`, `package_weights.py` | `export/onnx.py`, `export/quantize.py`, `export/package_weights.py` |
| audits | `audit_epoch_mixture.py`, `audit_mixed_script.py`, `audit_suffix_feed.py`, `census_opening_token.py` | `audits/epoch_mixture.py`, `audits/mixed_script.py`, `audits/suffix_feed.py`, `audits/opening_token.py` |
| observability | `trackio_logging.py` | `observability/trackio.py` |

`config/__init__.py` re-exports the public names so `from mailwoman_train.config import Config, load_config` keeps working:

```python
"""Run configuration: the typed schema and the strict loader."""

from .load import csv_log_path, load_config
from .schema import (
    Config,
    CorpusReceiptConfig,
    DataConfig,
    EvalConfig,
    ModelConfig,
    TrainConfig,
)

__all__ = [
    "Config",
    "CorpusReceiptConfig",
    "DataConfig",
    "EvalConfig",
    "ModelConfig",
    "TrainConfig",
    "csv_log_path",
    "load_config",
]
```

Every other role `__init__.py` is a docstring only. Do not add re-exports to them: an importer names the module it wants, which is what keeps the tree readable.

- [ ] **Step 1: Move one group**

Take the next group from the table. For each file:

```bash
git mv src/mailwoman_train/<old>.py src/mailwoman_train/<group>/<new>.py
```

- [ ] **Step 2: Repoint that group's importers**

```bash
grep -rn 'from \.<old> import\|from \.\.<old> import\|from mailwoman_train\.<old> import\|import mailwoman_train\.<old>' src tests scripts modal
```

Rewrite each hit to the new dotted path. A module that moved down one level needs its own relative imports re-leveled: `from .labels import` inside `src/mailwoman_train/nn/encoder.py` becomes `from ..labels import`.

- [ ] **Step 3: Run the suite**

```bash
uv run --extra dev --extra train pytest tests -q
```

Expected: at least **989 passed**. A failure here names exactly one unrepointed import — fix it and re-run before moving the next group.

- [ ] **Step 4: Lint and commit the group**

```bash
uvx ruff@0.16.5 check --fix . && uvx ruff@0.16.5 format .
git add -A
git commit -m "refactor(train): move <group> into its role directory"
```

- [ ] **Step 5: Repeat steps 1-4 for every remaining group**

Fourteen groups, fourteen commits. Do not batch them: a single green suite per group is what makes any one of them revertible.

- [ ] **Step 6: Type-check the whole tree**

```bash
uv run mypy
```

Expected: clean. `config/schema.py` is 478 lines, under the 500 limit; `tokenizer/__init__.py` is 609 and Task 4 splits it.

---

## Task 4: Split `tokenizer/__init__.py`

**Files:**
- Modify: `src/mailwoman_train/tokenizer/__init__.py` (609 lines)
- Create: `src/mailwoman_train/tokenizer/features.py`
- Test: existing coverage in `tests/mailwoman_train/test_tokenizer_alignment.py`

**Interfaces:**
- Consumes: `mailwoman_train.types.PieceSpan`, `mailwoman_train.features.*`.
- Produces: `tokenizer.Tokenizer` and `tokenizer.encode_with_features` remain importable from `mailwoman_train.tokenizer`. `encode_with_features` moves to `tokenizer/features.py` and is re-exported from `__init__.py`.

- [ ] **Step 1: Confirm the current size**

```bash
wc -l src/mailwoman_train/tokenizer/__init__.py
```

Expected: 609. The 500-line limit is the reason for this task.

- [ ] **Step 2: Move `encode_with_features` and its helpers**

Cut `encode_with_features` (the function holding the five channel blocks at former lines 535-620) into `tokenizer/features.py`, together with any module-private helper it alone calls. Keep the `Tokenizer` class, `PieceSpan` re-export and the plain encode path in `__init__.py`.

- [ ] **Step 3: Re-export from `__init__.py`**

```python
from .features import encode_with_features
```

Add `encode_with_features` to `__all__` if the module declares one.

- [ ] **Step 4: Run the suite**

```bash
uv run --extra dev --extra train pytest tests -q
wc -l src/mailwoman_train/tokenizer/__init__.py src/mailwoman_train/tokenizer/features.py
```

Expected: at least 989 passed, and both files under 500 lines.

- [ ] **Step 5: Commit**

```bash
uvx ruff@0.16.5 check --fix . && uvx ruff@0.16.5 format .
git add -A
git commit -m "refactor(tokenizer): split the feature-channel encode path out of the package index"
```

---

## Task 5: Split `nn/encoder.py`

**Files:**
- Modify: `src/mailwoman_train/nn/encoder.py` (1,429 lines; `__init__` 405, `forward` 415)
- Create: `src/mailwoman_train/nn/blocks.py`, `nn/char_cnn.py`, `nn/heads.py`, `nn/serialization.py`
- Test: `tests/mailwoman_train/test_v0_5_0_forward_pass.py`, `test_char_units.py`, `test_span_scorer.py` — all existing

**Interfaces:**
- Consumes: `mailwoman_train.config.Config`, `mailwoman_train.labels`, `nn.crf`, `nn.span_scorer`, `features.conventions`, `features.phrase_priors`.
- Produces: `nn.encoder.MailwomanCoarseEncoder`, `nn.encoder.build_model(cfg, vocab_size, pad_token_id, char_vocab_size=0)`, `nn.encoder.model_param_count(model)`. `nn.blocks.EncoderBlock` and `nn.char_cnn.CharCNNEmbedding` become importable in their own right.

This is the largest behavior-preserving change in the plan. A forward pass must produce identical tensors before and after, so the first step captures a reference.

- [ ] **Step 1: Capture a reference forward pass**

Write `tests/mailwoman_train/test_encoder_split_parity.py`:

```python
"""The split must not move a single logit.

Builds a small encoder from a fixed seed, runs one forward pass, and pins the output. The test is
written BEFORE the split so it fails on a changed tensor rather than describing what the split did.
"""

from __future__ import annotations

import torch

from mailwoman_train.nn.encoder import build_model
from mailwoman_train.config import load_config


def _tiny_model():
    cfg = load_config(None, strict=False)
    cfg.model.hidden_size = 32
    cfg.model.num_layers = 2
    cfg.model.num_heads = 2
    cfg.model.intermediate_size = 64
    torch.manual_seed(0)
    return build_model(cfg, vocab_size=64, pad_token_id=0)


def test_forward_is_deterministic_under_a_fixed_seed() -> None:
    model = _tiny_model()
    model.eval()
    input_ids = torch.arange(1, 9, dtype=torch.long).unsqueeze(0)
    attention_mask = torch.ones_like(input_ids)

    with torch.no_grad():
        first = model(input_ids=input_ids, attention_mask=attention_mask)
        second = model(input_ids=input_ids, attention_mask=attention_mask)

    first_logits = first["logits"] if isinstance(first, dict) else first.logits
    second_logits = second["logits"] if isinstance(second, dict) else second.logits
    assert torch.equal(first_logits, second_logits)
    assert first_logits.shape == (1, 8, model.config.num_labels)
```

If `load_config(None, strict=False)` does not yield a usable default, read `config/schema.py`'s `ModelConfig` defaults and construct `Config` directly. Do not weaken the assertion to make it pass.

- [ ] **Step 2: Run it and record the baseline**

```bash
uv run --extra dev --extra train pytest tests/mailwoman_train/test_encoder_split_parity.py -q
```

Expected: PASS before any split. Save the logits to a file the split can diff against:

```bash
uv run python - <<'PY' > /tmp/encoder-reference.txt
import torch
from tests.mailwoman_train.test_encoder_split_parity import _tiny_model
m = _tiny_model(); m.eval()
ids = torch.arange(1, 9, dtype=torch.long).unsqueeze(0)
out = m(input_ids=ids, attention_mask=torch.ones_like(ids))
logits = out["logits"] if isinstance(out, dict) else out.logits
print(logits.flatten().tolist())
PY
```

- [ ] **Step 3: Extract `CharCNNEmbedding` and `EncoderBlock`**

`git mv` is not usable here — these are classes inside a file. Cut `CharCNNEmbedding` (former `model.py:133-194`) into `nn/char_cnn.py` and `EncoderBlock` (former `model.py:84-132`) into `nn/blocks.py`, each with its docstring. Add to `nn/encoder.py`:

```python
from .blocks import EncoderBlock
from .char_cnn import CharCNNEmbedding
```

- [ ] **Step 4: Extract save/load**

Cut `save_pretrained` (former `model.py:1160`) and `from_pretrained` (former `:1240`) into `nn/serialization.py` as module-level functions taking the model as their first argument, then re-attach them as thin methods:

```python
    def save_pretrained(self, output_dir: Path | str) -> None:
        serialization.save_pretrained(self, output_dir)
```

Keep the classmethod shape of `from_pretrained` so `MailwomanCoarseEncoder.from_pretrained(model_dir)` still works — every checkpoint load in `train/` and `export/` calls it that way.

- [ ] **Step 5: Split `__init__` into named sub-builders**

The 405-line `__init__` assembles five independent pieces. Extract each into a private method returning what it builds, and leave `__init__` as the sequence of calls:

```python
    def __init__(self, config: Config, ...) -> None:
        super().__init__()
        self.config = config
        self.embeddings = self._build_embeddings()
        self.char_embedding = self._build_char_embedding()
        self.soft_feeds = self._build_soft_feed_projections()
        self.encoder_blocks = self._build_encoder_blocks()
        self.heads = self._build_heads()
        self._init_weights()
```

Each `_build_*` method holds the lines it already held, unchanged. Keep the attribute names exactly as they are — `save_pretrained` writes a state dict keyed on them, and a rename silently invalidates every checkpoint on the Modal volume.

- [ ] **Step 6: Split `forward` into staged helpers**

Same treatment for the 415-line `forward`: one private method per stage (embed, apply soft feeds, run blocks, compute each head's output), with `forward` as the sequence. Return the same object it returns today.

- [ ] **Step 7: Verify the tensors are identical**

```bash
uv run --extra dev --extra train pytest tests/mailwoman_train/test_encoder_split_parity.py -q
uv run python - <<'PY' > /tmp/encoder-after.txt
import torch
from tests.mailwoman_train.test_encoder_split_parity import _tiny_model
m = _tiny_model(); m.eval()
ids = torch.arange(1, 9, dtype=torch.long).unsqueeze(0)
out = m(input_ids=ids, attention_mask=torch.ones_like(ids))
logits = out["logits"] if isinstance(out, dict) else out.logits
print(logits.flatten().tolist())
PY
diff /tmp/encoder-reference.txt /tmp/encoder-after.txt && echo "IDENTICAL"
```

Expected: `IDENTICAL`. A diff here means a sub-builder changed an initialization order — find it before continuing.

- [ ] **Step 8: Run the suite and check sizes**

```bash
uv run --extra dev --extra train pytest tests -q
wc -l src/mailwoman_train/nn/*.py
```

Expected: at least 990 passed; every `nn/` module under 500 lines.

- [ ] **Step 9: Commit**

```bash
uvx ruff@0.16.5 check --fix . && uvx ruff@0.16.5 format .
uv run mypy
git add -A
git commit -m "refactor(nn): split the encoder into blocks, char CNN, heads and serialization"
```

---

## Task 6: Split `train/trainer.py`

**Files:**
- Modify: `src/mailwoman_train/train/trainer.py` (1,134 lines; `train()` is 476)
- Create: `src/mailwoman_train/train/noise.py`, `train/checkpoint.py`, `src/mailwoman_train/optim/schedules.py`, `optim/groups.py`, `src/mailwoman_train/eval/metrics.py`
- Test: `tests/mailwoman_train/test_resume_lr_restamp.py`, `test_metrics.py`, `test_checkpoint_atomicity.py`, `test_linear_cooldown_schedule.py`, `test_cosine_resume_spike.py` — all existing

**Interfaces:**
- Consumes: everything Tasks 3-5 produced.
- Produces:
  - `optim.schedules`: `cosine_with_warmup(optimizer, warmup_steps, max_steps)`, `linear_cooldown(optimizer, cooldown_start, max_steps)`, `constant_with_warmup(optimizer, warmup_steps)`, `build_scheduler(optim, cfg_train)`, `restamp_resume_lrs(...)`
  - `optim.groups`: `build_optimizer(...)`, `reinit_label_rows(model, labels)`
  - `train.noise`: `perturb_anchor_confidence(conf, step, max_steps)`, `perturb_gazetteer_confidence(conf, step, max_steps)`, `perturb_evidence_noise(...)`
  - `train.checkpoint`: `save_checkpoint(...)`, `find_latest_checkpoint(output_dir) -> Path | None`
  - `eval.metrics`: `token_f1(...)`, `cross_pollution(...)`, `eval_csv_row(step, elapsed, val, tags) -> list[str | int]`
  - `train.trainer`: `train(cfg, *, resume_from=None) -> None`, unchanged signature

The four private schedule functions lose their leading underscore when they move, because a module boundary is what made them private. Their call sites are all inside this task.

- [ ] **Step 1: Move the schedule and optimizer functions**

Cut `_cosine_with_warmup`, `_linear_cooldown`, `_constant_with_warmup`, `_build_scheduler` and `_restamp_resume_lrs` into `optim/schedules.py`, renaming each without the underscore. Cut `build_optimizer` and `reinit_label_rows` into `optim/groups.py`.

- [ ] **Step 2: Move the perturbations and metrics**

Cut `perturb_anchor_confidence`, `perturb_gazetteer_confidence` and `perturb_evidence_noise` into `train/noise.py`. Cut `_token_f1`, `_cross_pollution` and `eval_csv_row` into `eval/metrics.py`, dropping the underscores.

- [ ] **Step 3: Move checkpointing**

Cut `save_checkpoint` and `find_latest_checkpoint` into `train/checkpoint.py`.

- [ ] **Step 4: Repoint the test imports**

```bash
grep -rn '_cosine_with_warmup\|_linear_cooldown\|_constant_with_warmup\|_build_scheduler\|_restamp_resume_lrs\|_token_f1\|_cross_pollution' tests
```

Each hit imports a now-public name from a new module. `test_resume_lr_restamp.py` and `test_linear_cooldown_schedule.py` are the two that reach these directly.

- [ ] **Step 5: Run the suite**

```bash
uv run --extra dev --extra train pytest tests -q
wc -l src/mailwoman_train/train/trainer.py
```

Expected: at least 990 passed. `trainer.py` should now be near 400 lines, holding `train()`, `_set_seed`, `_to_tensor_batch`, `_precision_to_dtype` and `_eval_val`.

- [ ] **Step 6: Commit**

```bash
uvx ruff@0.16.5 check --fix . && uvx ruff@0.16.5 format .
uv run mypy
git add -A
git commit -m "refactor(train): move schedules, noise, metrics and checkpointing out of the loop"
```

---

## Task 7: `protocols.py`

**Files:**
- Create: `src/mailwoman_train/protocols.py`
- Test: `tests/mailwoman_train/test_protocols.py`

**Interfaces:**
- Consumes: `mailwoman_train.types.PieceSpan`.
- Produces: `protocols.CorpusBuilder`, `protocols.CountryModule`, `protocols.TrainCallback`. Task 8 implements `TrainCallback`; Task 9 implements `CountryModule`.

These are `typing.Protocol` declarations with `@runtime_checkable`, so a test can assert an implementation satisfies one without a base class. Nothing inherits from them.

- [ ] **Step 1: Write the failing test**

```python
"""Every declared protocol has at least one implementation that satisfies it."""

from __future__ import annotations

from mailwoman_train import protocols


def test_country_module_protocol_declares_the_expected_members() -> None:
    assert set(protocols.CountryModule.__protocol_attrs__) == {
        "country_code",
        "label_set_name",
        "build_corpus",
        "registers",
    }


def test_train_callback_protocol_declares_the_expected_members() -> None:
    assert set(protocols.TrainCallback.__protocol_attrs__) == {
        "on_train_begin",
        "on_step_end",
        "on_eval_end",
        "on_train_end",
    }
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
uv run --extra dev --extra train pytest tests/mailwoman_train/test_protocols.py -q
```

Expected: FAIL with `ModuleNotFoundError: No module named 'mailwoman_train.protocols'`.

- [ ] **Step 3: Write `protocols.py`**

```python
"""The interfaces the swappable pieces satisfy.

A country's contribution, a corpus builder and a training callback are each declared here so an
implementer reads one interface rather than inferring the shape from an existing implementation.
Nothing inherits from these; they are structural, checked by mypy and by `isinstance` in tests.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class CorpusBuilder(Protocol):
    """Writes labeled parquet rows for one corpus recipe."""

    def build(self, output_dir: Path, *, limit: int | None = None) -> int:
        """Write the rows and answer how many landed."""
        ...


@runtime_checkable
class CountryModule(Protocol):
    """What one country contributes to training.

    A country supplies a corpus builder and, where a government register exists, a reader for it.
    `registers` answers an empty mapping for a country whose corpus comes from Overture alone.
    """

    country_code: str
    label_set_name: str

    def build_corpus(self, output_dir: Path, *, limit: int | None = None) -> int: ...

    def registers(self) -> dict[str, Any]: ...


@runtime_checkable
class TrainCallback(Protocol):
    """One concern observed during a training run.

    Every hook answers None. A callback never changes the loop's control flow; it observes, writes,
    or reports. A hook that needs to stop a run raises.
    """

    def on_train_begin(self, state: Any) -> None: ...

    def on_step_end(self, state: Any, step: int) -> None: ...

    def on_eval_end(self, state: Any, step: int, metrics: dict[str, float]) -> None: ...

    def on_train_end(self, state: Any) -> None: ...
```

- [ ] **Step 4: Run the test and the suite**

```bash
uv run --extra dev --extra train pytest tests/mailwoman_train/test_protocols.py -q
uv run --extra dev --extra train pytest tests -q
```

Expected: PASS; at least 992 passed overall.

- [ ] **Step 5: Commit**

```bash
uvx ruff@0.16.5 check --fix . && uvx ruff@0.16.5 format .
uv run mypy
git add -A
git commit -m "feat(train): declare the country, corpus-builder and callback interfaces"
```

---

## Task 8: `train/callbacks/`

**Files:**
- Create: `src/mailwoman_train/train/callbacks/__init__.py`, `callbacks/console.py`, `callbacks/csv_metrics.py`, `callbacks/evaluator.py`, `callbacks/checkpointer.py`, `callbacks/trackio.py`
- Modify: `src/mailwoman_train/train/trainer.py`
- Test: `tests/mailwoman_train/test_train_callbacks.py`

**Interfaces:**
- Consumes: `protocols.TrainCallback` (Task 7), `train.checkpoint.save_checkpoint`, `eval.metrics.eval_csv_row`, `observability.trackio`.
- Produces: `train.callbacks.default_callbacks(cfg) -> list[TrainCallback]`, and the five classes `ConsoleCallback`, `CSVMetricsCallback`, `EvaluatorCallback`, `CheckpointerCallback`, `TrackioCallback`. `train.trainer.train` gains a keyword-only `callbacks: list[TrainCallback] | None = None` defaulting to `default_callbacks(cfg)`.

Note the class name: `CSVMetricsCallback`, with the acronym capitalized as a whole component.

- [ ] **Step 1: Write the failing test**

```python
"""A callback observes the loop without steering it."""

from __future__ import annotations

from mailwoman_train import protocols
from mailwoman_train.train import callbacks


class _Recorder:
    def __init__(self) -> None:
        self.events: list[str] = []

    def on_train_begin(self, state: object) -> None:
        self.events.append("begin")

    def on_step_end(self, state: object, step: int) -> None:
        self.events.append(f"step:{step}")

    def on_eval_end(self, state: object, step: int, metrics: dict[str, float]) -> None:
        self.events.append(f"eval:{step}")

    def on_train_end(self, state: object) -> None:
        self.events.append("end")


def test_a_plain_class_satisfies_the_protocol_without_inheriting() -> None:
    assert isinstance(_Recorder(), protocols.TrainCallback)


def test_every_shipped_callback_satisfies_the_protocol() -> None:
    for callback_class in (
        callbacks.ConsoleCallback,
        callbacks.CSVMetricsCallback,
        callbacks.EvaluatorCallback,
        callbacks.CheckpointerCallback,
        callbacks.TrackioCallback,
    ):
        assert hasattr(callback_class, "on_step_end")
        assert hasattr(callback_class, "on_train_end")
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
uv run --extra dev --extra train pytest tests/mailwoman_train/test_train_callbacks.py -q
```

Expected: FAIL with `ImportError: cannot import name 'callbacks'`.

- [ ] **Step 3: Write the five callbacks**

Each holds the code `train()` runs inline today, moved without change:

- `ConsoleCallback` — the periodic progress print.
- `CSVMetricsCallback` — calls `eval_csv_row` and appends to the CSV at `config.csv_log_path(cfg)`.
- `EvaluatorCallback` — calls `_eval_val` on the eval interval and returns its metrics through `on_eval_end`.
- `CheckpointerCallback` — calls `save_checkpoint` on the checkpoint interval.
- `TrackioCallback` — the best-effort trackio write. It already guards its own import, so keep that guard: trackio's absence must never break a run.

`callbacks/__init__.py` exports the five plus:

```python
def default_callbacks(cfg: Config) -> list[TrainCallback]:
    """The callbacks a run gets when the caller names none.

    Trackio joins only when the recipe asks for it, because its absence is normal and its failure
    must stay silent.
    """
    chosen: list[TrainCallback] = [
        ConsoleCallback(cfg),
        CSVMetricsCallback(cfg),
        EvaluatorCallback(cfg),
        CheckpointerCallback(cfg),
    ]
    if cfg.train.trackio_enabled:
        chosen.append(TrackioCallback(cfg))
    return chosen
```

- [ ] **Step 4: Rewrite `train()` to drive them**

Replace the inline logging, eval, checkpoint and trackio blocks with hook calls at the same points in the loop. The loop keeps its own control flow — a callback never decides whether to continue.

- [ ] **Step 5: Run the suite**

```bash
uv run --extra dev --extra train pytest tests -q
wc -l src/mailwoman_train/train/trainer.py
```

Expected: at least 994 passed. `train()` should now be under 120 lines.

- [ ] **Step 6: Run a smoke train to prove the loop still trains**

```bash
uv run python -m mailwoman_train smoke --help
```

If `cmd_smoke` (former `cli.py:270`) offers a CPU-only smoke path, run it. This exercises the rewritten loop without touching Modal. If it requires a corpus that is not on this machine, say so in the commit message rather than skipping silently.

- [ ] **Step 7: Commit**

```bash
uvx ruff@0.16.5 check --fix . && uvx ruff@0.16.5 format .
uv run mypy
git add -A
git commit -m "feat(train): drive logging, eval, checkpointing and trackio through callbacks"
```

---

## Task 9: `countries/`

**Files:**
- Create: `src/mailwoman_train/countries/__init__.py`, `countries/jp/{__init__,registers,corpora,text}.py`, `countries/kr/{__init__,registers,corpora,juso}.py`, `countries/tw/{__init__,registers,corpora}.py`, `countries/cjk/{__init__,overlay}.py`
- Move: `jp_registry.py`, `jp_kana.py`, `build_jp_slice.py`, `kr_registry.py`, `kr_juso.py`, `build_kr_slice.py`, `tw_registry.py`, `build_tw_slice.py`, `build_cjk_overlay.py`
- Test: `tests/mailwoman_train/test_country_registry.py`

**Interfaces:**
- Consumes: `protocols.CountryModule` (Task 7), `text.kana`, `text.normalize`, `corpora.builder` (Task 2).
- Produces: `countries.COUNTRY_MODULES: dict[str, CountryModule]` keyed by ISO 3166-1 alpha-2 lowercase (`"jp"`, `"kr"`, `"tw"`), and `countries.country_module(code) -> CountryModule` raising `KeyError` with the known codes listed.

`JP_PREFECTURES`, `normalize_name`, `normalize_number` and `split_street` move from `build_jp_slice.py` to `countries/jp/text.py` here. `normalize_name`'s docstring carries a measured number — carry it verbatim.

`BOARD_BUCKET_MIN` moves into each country's own module, resolving the aliasing at `build_registry_corpus.py:35-37`.

- [ ] **Step 1: Write the failing test**

```python
"""A country is found through the registry, not by importing its module by name."""

from __future__ import annotations

import pytest

from mailwoman_train import protocols
from mailwoman_train.countries import COUNTRY_MODULES, country_module


def test_the_three_built_countries_are_registered() -> None:
    assert set(COUNTRY_MODULES) >= {"jp", "kr", "tw"}


def test_every_registered_country_satisfies_the_protocol() -> None:
    for code, module in COUNTRY_MODULES.items():
        assert module.country_code == code
        assert isinstance(module, protocols.CountryModule), code


def test_an_unknown_code_names_the_known_ones() -> None:
    with pytest.raises(KeyError) as caught:
        country_module("zz")
    assert "jp" in str(caught.value)
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
uv run --extra dev --extra train pytest tests/mailwoman_train/test_country_registry.py -q
```

Expected: FAIL with `ModuleNotFoundError: No module named 'mailwoman_train.countries'`.

- [ ] **Step 3: Move Japan**

```bash
mkdir -p src/mailwoman_train/countries/jp
git mv src/mailwoman_train/jp_registry.py src/mailwoman_train/countries/jp/registers.py
git mv src/mailwoman_train/jp_kana.py src/mailwoman_train/countries/jp/kana.py
git mv src/mailwoman_train/build_jp_slice.py src/mailwoman_train/countries/jp/corpora.py
```

Cut `JP_PREFECTURES`, `normalize_name`, `normalize_number` and `split_street` from `corpora.py` into `countries/jp/text.py`. Repoint `registers.py`'s former line 32 to `from .text import JP_PREFECTURES, normalize_name, split_street`.

Write `countries/jp/__init__.py` exposing a module object that satisfies `CountryModule`:

```python
"""Japan. Corpus from Overture-JP; registers from KEN_ALL and the municipality register."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from . import corpora, registers

country_code = "jp"
label_set_name = "stage3-cjk"
BOARD_BUCKET_MIN = 90


def build_corpus(output_dir: Path, *, limit: int | None = None) -> int:
    return corpora.build(output_dir, limit=limit)


def registers() -> dict[str, Any]:
    return {"ken_all": _registers.KenAllIndex}
```

The import at the top of that file is `from . import corpora, registers as _registers`, because the module-level function is named `registers` to match `protocols.CountryModule`. A country with no government register answers `{}`.

Read `build_jp_slice.py`'s actual entry point before writing `build_corpus` — if its top-level builder has a different name or signature, match it rather than inventing one, and record the real signature in this task's commit message so Tasks 10-11 can rely on it.

- [ ] **Step 4: Move Korea, Taiwan and the CJK overlay**

The same moves:

```bash
mkdir -p src/mailwoman_train/countries/kr src/mailwoman_train/countries/tw src/mailwoman_train/countries/cjk
git mv src/mailwoman_train/kr_registry.py src/mailwoman_train/countries/kr/registers.py
git mv src/mailwoman_train/kr_juso.py src/mailwoman_train/countries/kr/juso.py
git mv src/mailwoman_train/build_kr_slice.py src/mailwoman_train/countries/kr/corpora.py
git mv src/mailwoman_train/tw_registry.py src/mailwoman_train/countries/tw/registers.py
git mv src/mailwoman_train/build_tw_slice.py src/mailwoman_train/countries/tw/corpora.py
git mv src/mailwoman_train/build_cjk_overlay.py src/mailwoman_train/countries/cjk/overlay.py
```

`countries/cjk/` is a regional grouping, matching `packages/corpus/lib/south-asia/`. It carries no `country_code` and is not in `COUNTRY_MODULES`.

- [ ] **Step 5: Write the registry**

`countries/__init__.py`:

```python
"""Per-country training code, keyed by ISO 3166-1 alpha-2.

A country directory holds only what is specific to that country. Shared machinery lives in the role
directories at the package root: `text/` for script normalization, `corpora/` for the row builders.
Adding a country means adding a directory that satisfies `protocols.CountryModule` and one line here.
"""

from __future__ import annotations

from typing import Any

from . import jp, kr, tw

COUNTRY_MODULES: dict[str, Any] = {
    "jp": jp,
    "kr": kr,
    "tw": tw,
}


def country_module(code: str) -> Any:
    """The country module for an alpha-2 code, lowercased."""
    key = code.lower()
    if key not in COUNTRY_MODULES:
        known = ", ".join(sorted(COUNTRY_MODULES))
        raise KeyError(f"no country module for {code!r}; known codes: {known}")
    return COUNTRY_MODULES[key]
```

- [ ] **Step 6: Repoint every importer and move `build_registry_corpus.py`**

```bash
grep -rn 'build_jp_slice\|build_kr_slice\|build_tw_slice\|build_cjk_overlay\|jp_registry\|kr_registry\|tw_registry\|kr_juso\|jp_kana' src tests scripts modal
```

`build_registry_corpus.py` moves to `corpora/registry.py` and now imports `BOARD_BUCKET_MIN` from each country module, which removes the `JP_BOARD_BUCKET_MIN` / `TW_BOARD_BUCKET_MIN` aliases. `build_fragment_slice.py` and `build_secondary_slice.py` move to `corpora/fragment.py` and `corpora/secondary.py` — both have zero intra-package imports, so nothing repoints.

- [ ] **Step 7: Run the suite**

```bash
uv run --extra dev --extra train pytest tests -q
```

Expected: at least 997 passed.

- [ ] **Step 8: Commit**

```bash
uvx ruff@0.16.5 check --fix . && uvx ruff@0.16.5 format .
uv run mypy
git add -A
git commit -m "refactor(train): key per-country code by country under countries/"
```

---

## Task 10: `cli/commands/`

**Files:**
- Create: `src/mailwoman_train/cli/__init__.py`, `cli/parser.py`, `cli/commands/*.py`
- Move: `src/mailwoman_train/cli.py` (654 lines), and fifteen of `scripts/*.py`
- Modify: `src/mailwoman_train/__main__.py`
- Test: `tests/mailwoman_train/test_cli_commands.py`

**Interfaces:**
- Consumes: every role module.
- Produces: `cli.main(argv=None)`, and one `cli/commands/<name>.py` per subcommand, each exporting `add_parser(subparsers) -> None` and `run(args) -> int`.

`scripts/verify_toolchain.py` does NOT move. Measured reason: its imports are `importlib.metadata`, `re`, `sys`, `tomllib` and `pathlib` — standard library only — and `.husky/pre-commit:63` plus `package.json:54` invoke it as bare `python3` with no `uv run`. Folding it into the CLI would make the pre-commit hook depend on a synced venv.

- [ ] **Step 1: Write the failing test**

```python
"""Every subcommand is reachable and declares its own parser."""

from __future__ import annotations

import pytest

from mailwoman_train.cli import build_parser

EXPECTED = {
    "train",
    "eval",
    "export",
    "quantize",
    "package",
    "smoke",
    "tokenizer",
    "verify-tokenizer",
}


def test_every_expected_subcommand_is_registered() -> None:
    parser = build_parser()
    actions = [a for a in parser._subparsers._group_actions if hasattr(a, "choices")]
    registered = set(actions[0].choices)
    assert EXPECTED <= registered


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_each_subcommand_accepts_help(name: str) -> None:
    parser = build_parser()
    with pytest.raises(SystemExit) as caught:
        parser.parse_args([name, "--help"])
    assert caught.value.code == 0
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
uv run --extra dev --extra train pytest tests/mailwoman_train/test_cli_commands.py -q
```

Expected: FAIL with `ImportError: cannot import name 'build_parser' from 'mailwoman_train.cli'`.

- [ ] **Step 3: Split `cli.py`**

One file per `cmd_*` function from the former `cli.py`: `cmd_train` (line 41) to `cli/commands/train.py`, `cmd_eval` (83) to `eval.py`, `cmd_export` (124) to `export.py`, `cmd_quantize` (189) to `quantize.py`, `cmd_package` (197) to `package.py`, `cmd_smoke` (270) to `smoke.py`, `cmd_tokenizer` (425) to `tokenizer.py`, `cmd_verify_tokenizer` (481) to `verify_tokenizer.py`.

Each exports `run(args) -> int` (the former `cmd_*` body) and `add_parser(subparsers) -> None` (the lines of the former `build_parser` that declare this command's flags). Private helpers move with the command that calls them: `_apply_smoke_mode` with `smoke.py`, `_resolve_corpus_dir` and `_infer_corpus_version` with `tokenizer.py`, `_find_packages_root` with `package.py`.

`cli/parser.py` holds `build_parser()`, which imports each command module and calls its `add_parser`. `cli/__init__.py` re-exports `build_parser` and `main`.

- [ ] **Step 4: Fold in the fifteen scripts**

Each becomes a subcommand. The two kebab-case files get importable names: `scripts/fit-isotonic-calibration.py` to `cli/commands/fit_calibration.py`, `scripts/calibration-drift-guard.py` to `cli/commands/calibration_guard.py`.

Add each to `EXPECTED` in the test as you add it, so the test tracks reality rather than lagging it.

- [ ] **Step 5: Verify the entry point**

```bash
uv run python -m mailwoman_train --help
uv run python -m mailwoman_train train --help
```

Expected: both print help and exit 0.

- [ ] **Step 6: Run the suite**

```bash
uv run --extra dev --extra train pytest tests -q
ls scripts/
```

Expected: at least 1006 passed; `scripts/` holds `verify_toolchain.py` alone.

- [ ] **Step 7: Confirm the pre-commit path still works**

```bash
python3 scripts/verify_toolchain.py
```

Expected: exit 0, run with the system `python3` and no `uv`. This is the check that the hook at `.husky/pre-commit:63` performs.

- [ ] **Step 8: Commit**

```bash
uvx ruff@0.16.5 check --fix . && uvx ruff@0.16.5 format .
uv run mypy
git add -A
git commit -m "refactor(cli): one file per subcommand, absorbing the one-off scripts"
```

---

## Task 11: Pin the launcher's behavior before touching it

**Files:**
- Create: `tests/launch/test_sync_table_parity.py`, `tests/launch/__init__.py`
- Read only: `modal/train_remote.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `tests/launch/extract_current.py`, holding `extract_sync_functions(source: str) -> dict[str, SyncSpec]` where `SyncSpec` carries `rclone_commands: list[str]`, `check_paths: list[str]` and `pycache_paths: list[str]`.

No test imports `modal/train_remote.py` today. So "the suite still passes" after the collapse would carry no information. This task writes the instrument first.

- [ ] **Step 1: Write the extractor**

`tests/launch/extract_current.py` parses `modal/train_remote.py` with `ast` and, for each `def sync_*`, collects every string literal assigned into a list named `commands` and every string literal appearing inside an `os.path.isfile` call. It resolves f-strings by substituting the module-level constants `VOL_MOUNT` and `BUCKET`, whose values it also reads from the AST.

- [ ] **Step 2: Run it and record the census**

```bash
uv run python -c "
from tests.launch.extract_current import extract_sync_functions
from pathlib import Path
specs = extract_sync_functions(Path('modal/train_remote.py').read_text())
print(len(specs), 'sync functions')
print(sum(len(s.rclone_commands) for s in specs.values()), 'rclone commands')
print(sum(len(s.check_paths) for s in specs.values()), 'check paths')
"
```

Expected: **57** sync functions. Put the three counts in the commit message; Task 13 diffs against them.

If the count is not 57, stop and report. The extractor is missing a shape, and a missing shape means a corpus version whose sync would silently vanish.

- [ ] **Step 3: Write the parity test**

```python
"""The table-driven sync must generate exactly what the 57 clones do today.

`modal/train_remote.py` has no test coverage, so a green suite after the collapse proves nothing on
its own. This test is that proof: it pins every generated command and check path against the literal
strings in the pre-collapse file, which is committed as a fixture.
"""

from __future__ import annotations

import json
from pathlib import Path

FIXTURE = Path(__file__).parent / "sync-census.json"


def test_the_census_fixture_matches_the_committed_table() -> None:
    from launch.corpora import CORPUS_VERSIONS
    from launch.sync import plan_sync

    expected = json.loads(FIXTURE.read_text())
    actual = {
        name: {
            "rclone_commands": plan_sync(entry).rclone_commands,
            "check_paths": sorted(plan_sync(entry).check_paths),
        }
        for name, entry in CORPUS_VERSIONS.items()
    }
    assert actual == expected
```

- [ ] **Step 4: Generate and commit the fixture**

```bash
uv run python -c "
import json
from pathlib import Path
from tests.launch.extract_current import extract_sync_functions
specs = extract_sync_functions(Path('modal/train_remote.py').read_text())
Path('tests/launch/sync-census.json').write_text(json.dumps(
    {n: {'rclone_commands': s.rclone_commands, 'check_paths': sorted(s.check_paths)}
     for n, s in specs.items()}, indent='\t', sort_keys=True) + '\n')
"
wc -l tests/launch/sync-census.json
```

The fixture is the pre-collapse behavior, frozen. Do not regenerate it after Task 13 — that would make the test assert the new code against itself.

- [ ] **Step 5: Commit**

```bash
git add tests/launch
git commit -m "test(launch): pin the 57 sync functions before collapsing them"
```

---

## Task 12: Rename `modal/` to `launch/`

**Files:**
- Move: `modal/train_remote.py`, `modal/AGENTS.md`, `modal/CLAUDE.md`
- Create: `launch/__init__.py`
- Modify: `REPRODUCIBILITY.md:28,31`, `packages/mailwoman/lib/dev-tools/verify-export-quant-versions.run.ts:24`

**Interfaces:**
- Consumes: nothing.
- Produces: `launch` as an importable package. `modal run -m launch.train` replaces `modal run corpus-python/modal/train_remote.py`.

The rename is forced, not stylistic. Step 1 re-measures the reason.

- [ ] **Step 1: Re-measure the shadowing**

```bash
uv run python -c "import sys; sys.path.insert(0,'.'); import modal; print('resolved to:', modal.__file__)"
```

Expected: `resolved to: None`, meaning `import modal` found the local directory as a namespace package rather than the SDK. Record the output in the commit message.

- [ ] **Step 2: Rename**

```bash
git mv modal launch
```

- [ ] **Step 3: Verify the shadow is gone**

```bash
uv run python -c "import sys; sys.path.insert(0,'.'); import modal; print('resolved to:', modal.__file__)"
```

Expected: a path ending in `site-packages/modal/__init__.py`. If it still prints `None`, a stale `modal/` remains — check `git status` and `find . -name modal -maxdepth 2 -not -path './.venv/*'`.

- [ ] **Step 4: Sweep the quoted literals**

```bash
cd /home/lab/Projects/mailwoman/.claude/worktrees/python-layout
grep -rn 'modal/train_remote\.py\|corpus-python/modal' --include='*.ts' --include='*.md' --include='*.json' --include='*.yml' . \
  --exclude-dir=node_modules --exclude-dir=.venv --exclude-dir=.git --exclude-dir=docs/records
```

Rewrite each hit. The known set: `REPRODUCIBILITY.md:28,31`, `packages/mailwoman/lib/dev-tools/verify-export-quant-versions.run.ts:24`, `launch/AGENTS.md`, and the fixture strings in `packages/dev-mcp/test/unit/bash-write-guard.test.ts:85-89,95,154,204`.

Leave `docs/records/` alone — those are dated point-in-time records and keep the path that was true when written.

- [ ] **Step 5: Confirm the Bash write guard still fires**

The guard matches `head: "modal"` at `packages/dev-mcp/lib/hooks/bash/write/rules.ts:196`, not a filename, so a renamed target changes nothing. Confirm by reading that rule, and update the fixture strings in `bash-write-guard.test.ts` to the new path so the test describes a command someone could actually type.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(launch): rename modal/ to launch/ so the package stops shadowing the SDK"
```

---

## Task 13: Collapse the launcher

**Files:**
- Create: `launch/app.py`, `launch/env.py`, `launch/corpora.py`, `launch/sync.py`, `launch/init.py`, `launch/train.py`, `launch/export.py`, `launch/diagnostics/*.py`
- Delete: `launch/train_remote.py`
- Modify: `launch/AGENTS.md`

**Interfaces:**
- Consumes: the fixture from Task 11.
- Produces:
  - `launch.corpora.CORPUS_VERSIONS: dict[str, CorpusVersion]`, where `CorpusVersion` carries `version: str`, `rclone_pairs: list[tuple[str, str]]`, `check_paths: list[str]`, `pycache_paths: list[str]`
  - `launch.sync.plan_sync(entry) -> SyncPlan` with `rclone_commands: list[str]` and `check_paths: list[str]`
  - `launch.sync.sync_corpus(version: str)`, the single Modal function
  - `launch.init.mean_init(name: str)`, replacing the seven `mean_init_*`

- [ ] **Step 1: Split the non-sync content first**

Move `app`, `vol`, `training_image`, `R2_KEYS`, `VOL_MOUNT`, `BUCKET` and the secrets into `launch/app.py`. Move `_env_file`, `_read_env_keys`, `_load_r2_env` and `_load_hf_env` into `launch/env.py`. Move `_train_gpu`, `main`, `preflight_corpus_receipts` and `_required_train_seconds` into `launch/train.py`. Move `export_onnx` and `quantize_onnx` into `launch/export.py`. Move the ten diagnostics into `launch/diagnostics/`.

`launch/__init__.py` imports every member so the decorated functions register under Modal's module mode:

```python
"""Modal launch surface.

Modal registers a function when the module holding its decorator is imported, and module mode
(`modal run -m launch.<module>`) imports only the named module. This file imports every member so a
run from any entry point sees the whole app.
"""

from . import diagnostics, env, export, init, sync, train  # noqa: F401
from .app import app  # noqa: F401
```

- [ ] **Step 2: Write the table**

`launch/corpora.py` holds one entry per corpus version, each carrying what a clone varied. Generate the first draft from the extractor:

```bash
uv run python -c "
from tests.launch.extract_current import extract_sync_functions
from pathlib import Path
for name, spec in sorted(extract_sync_functions(Path('launch/train_remote.py').read_text()).items()):
    print(name, len(spec.rclone_commands), len(spec.check_paths))
"
```

Transcribe each into a `CorpusVersion`. Read every one; the generator gives you the rows, not the review.

- [ ] **Step 3: Write the single sync function**

`launch/sync.py` holds `plan_sync` (pure, no Modal, no network — this is what the parity test calls) and one `@app.function`-decorated `sync_corpus(version: str)` that runs the plan.

- [ ] **Step 4: Run the parity test**

```bash
uv run --extra dev --extra train pytest tests/launch/test_sync_table_parity.py -q
```

Expected: PASS. A failure names the version whose generated commands differ from the frozen census. Fix the table entry, never the fixture.

- [ ] **Step 5: Collapse the seven `mean_init_*`**

The same treatment, into `launch/init.py` as one `mean_init(name: str)` over a table.

- [ ] **Step 6: Delete the old file and verify the app loads**

```bash
git rm launch/train_remote.py
uv run python -c "import launch; print(len(launch.app.registered_functions), 'functions registered')"
```

Expected: a count covering every surviving function. If the Modal version does not expose `registered_functions`, use `modal app list` against a dry parse, or confirm by importing each module without error.

- [ ] **Step 7: Rewrite `launch/AGENTS.md` step 4**

Step 4 currently reads "Add a `sync_v0XX` to `train_remote.py`, mirroring `sync_v050`". Rewrite it to describe adding a row to `launch/corpora.py`, and update every `modal run scripts/modal/train_remote.py::…` command in that file to `modal run -m launch.<module>`. That path prefix is stale twice over — `scripts/modal/` has not existed since the 2026-07-09 regroup.

- [ ] **Step 8: Run everything and commit**

```bash
uv run --extra dev --extra train pytest tests -q
uvx ruff@0.16.5 check --fix . && uvx ruff@0.16.5 format .
git add -A
git commit -m "refactor(launch): drive corpus sync from a table instead of 57 clones"
```

---

## Task 14: Mirror the tests, add the check, finish packaging

**Files:**
- Move: 74 files under `tests/mailwoman_train/`
- Create: `src/mailwoman_train/py.typed`, `packages/repo-health/lib/checks/python-prefix-directories.ts`
- Delete: `src/mailwoman_corpus/`
- Modify: `corpus-python/pyproject.toml`, `packages/repo-health/lib/registry.ts`

**Interfaces:**
- Consumes: the finished source tree.
- Produces: a test tree mirroring the source tree, and a `repo-health` check that keeps §5 satisfied.

- [ ] **Step 1: Mirror the test tree**

Move each test beside the module it covers: `test_crf.py` to `tests/mailwoman_train/nn/test_crf.py`, `test_augment.py` to `tests/mailwoman_train/data/test_augment.py`, and so on. Add an `__init__.py` to each new directory. The prefix groups from spec §5 (`span` 4, `tokenizer` 3, `jp` 3, `char` 3, `audit` 3, `anchor` 3, `country` 2, `augment` 2) resolve as a consequence.

- [ ] **Step 2: Run the suite from the new tree**

```bash
uv run --extra dev --extra train pytest tests -q
```

Expected: the same count as after Task 13. A drop means a test file was moved without its fixture.

- [ ] **Step 3: Add `py.typed` and widen mypy**

```bash
touch src/mailwoman_train/py.typed
```

In `pyproject.toml`, change `files = ["src"]` to `files = ["src", "launch"]`. Leave `tests` out: `uv run mypy --strict tests` reports 663 errors in 54 of 56 files, so admitting it is its own arc.

Add `py.typed` to the package data so it ships:

```toml
[tool.setuptools.package-data]
mailwoman_train = ["py.typed"]
```

- [ ] **Step 4: Delete the empty package**

```bash
grep -rn 'mailwoman_corpus' --include='*.py' --include='*.toml' --include='*.json' . --exclude-dir=.venv --exclude-dir=.mypy_cache | grep -v egg-info
git rm -r src/mailwoman_corpus
```

Expected: the grep prints nothing before the delete. If it prints a hit, stop — the spec's claim of zero importers was measured on 2026-09-12 and something has changed.

- [ ] **Step 5: Write the Python prefix check**

`packages/repo-health/lib/checks/python-prefix-directories.ts` mirrors `prefix-directories.ts` with `_` as the delimiter and `.py` as the source extension, scoped to `corpus-python/`. Register it in `packages/repo-health/lib/registry.ts`.

The TypeScript check excludes workspace directories because a directory name is an npm package name. There is no Python equivalent, so that exclusion does not carry over. `__init__.py` and `__main__.py` are excluded: both are Python's own names, not this repository's to arrange.

- [ ] **Step 6: Run the check and the repo's own suites**

```bash
cd /home/lab/Projects/mailwoman/.claude/worktrees/python-layout
yarn mwops health python-prefix-directories
```

Expected: zero groups.

- [ ] **Step 7: Run the full acceptance set**

```bash
cd corpus-python
uv run --extra dev --extra train pytest tests -q
uv run mypy
uvx ruff@0.16.5 check corpus-python
uvx ruff@0.16.5 format --check corpus-python
uv run bandit -c pyproject.toml -r src
python3 scripts/verify_toolchain.py
cd ..
yarn health
yarn test
```

Every one must pass. `yarn health` and `yarn test` need `node_modules` in the worktree; run `yarn install` first if they fail on a missing state file.

- [ ] **Step 8: Verify the size and hygiene criteria**

```bash
cd corpus-python
find src/mailwoman_train -name '*.py' -exec wc -l {} + | sort -rn | head -5
uv run --extra dev --extra train pytest tests/mailwoman_train/test_import_hygiene.py -q
```

Expected: no module over 500 lines; the hygiene test passes.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore(train): mirror the test tree, ship py.typed, add the Python prefix check"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: §3.1 to Task 1, §3.2 to Task 2, §4 and §6 to Tasks 3-6, §7 to Tasks 7-8, §4's country model to Task 9, §8.6 to Task 10, §8.4 to Task 11, §8.1 and §8.5 to Task 12, §8.2 and §8.3 to Task 13, §9 to Task 14. §11's acceptance criteria run in Task 14 steps 7-8. §12's out-of-scope items appear in no task, which is correct.

**Type consistency.** `PieceSpan` is defined in Task 1 and consumed by name in Tasks 2, 4 and 7. `protocols.TrainCallback` is defined in Task 7 with four hooks and implemented in Task 8 with the same four. `protocols.CountryModule` declares `country_code`, `label_set_name`, `build_corpus` and `registers`, and Task 9's `countries/jp/__init__.py` now supplies all four under those names. The first draft called the last one `registers_available`, which would have failed Task 9's own `isinstance` check against the protocol; it is corrected in the task body. Task 5 step 4's `serialization.save_pretrained` names the module that same step creates.

**Known soft spot.** Task 9 step 3's `build_corpus` body assumes `build_jp_slice.py` exposes a `build(output_dir, limit=...)` entry point. The step says to read the real signature first and record it, rather than inventing one. Treat a mismatch there as expected work, not as a plan failure.
