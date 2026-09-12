# `corpus-python` layout — design

Status: proposed 2026-09-12, measured on `worktree-python-layout` at 5104b571d. Approved in outline by the operator:
role directories at the top, `countries/<cc>/` for country-specific code, `launch/` as the new name for `modal/`, and
the extension work (declared protocols plus training callbacks) folded into the same arc rather than deferred.

## 1. The decision this serves

`corpus-python/` is the one part of this repository that no structural check reads. The TypeScript side has
`repo-health`, `dependency-cruiser`, `oxlint.plugin.ts` and the `HELPER_HOMES` table; the Python side has ruff, mypy
and bandit, none of which see layout. The result is 48 flat modules, a 5,278-line launcher, and a duplicate-helper
pattern that `AGENTS.md` names for TypeScript and nothing reports for Python.

Two requirements shape the target. The first is that a reader can find where a thing lives. The second is that the
tree admits every country: the per-country Python code today is eight modules for three countries, and the plan is
every country, so a layout that costs one top-level entry per country does not survive.

## 2. What exists, measured

| Unit                     | Lines                  | Shape                                                                     |
| ------------------------ | ---------------------- | ------------------------------------------------------------------------- |
| `modal/train_remote.py`  | 5,278                  | one file, 92 top-level defs: 57 `sync_*`, 7 `mean_init_*`, 10 diagnostics |
| `src/mailwoman_train/`   | 17,371 over 48 modules | flat, no subpackages                                                      |
| `src/mailwoman_corpus/`  | 7                      | a docstring and a `__version__`; zero importers in the tree               |
| `scripts/`               | 3,800 over 17 files    | 15 `snake_case.py`, 2 `kebab-case.py` (unimportable as modules)           |
| `tests/mailwoman_train/` | 9,793 over 74 files    | flat, mirrors the flat source                                             |

Baseline on this branch: `983 passed, 11 skipped, 26 warnings in 29.60s` under
`uv run --extra dev --extra train pytest tests -q`.

The four longest functions:

| Site                | Lines | What it holds                                                                         |
| ------------------- | ----- | ------------------------------------------------------------------------------------- |
| `model.py:215-620`  | 405   | `MailwomanCoarseEncoder.__init__` — char CNN, soft-feed channels, CRF, span head, MLM |
| `model.py:653-1068` | 415   | the same class's `forward`                                                            |
| `train.py:659-1134` | 476   | `train()` — the loop plus logging, periodic eval, checkpointing, trackio              |
| `data_loader.py`    | 1,074 | manifest reader, path resolver, source sampler, row stream, encoder, collator         |

`config.py` is excluded from this work. It is 629 lines of typed dataclasses with a strict merge/coerce loader, which
is the shape every reference project converges on. It moves into `config/` as two modules and is otherwise untouched.

## 3. Two structural defects the layout resolves

### 3.1 A cycle between `tokenizer.py` and the alignment modules

```
gazetteer_anchor.py:28   from .tokenizer import PieceSpan
country_lexicon.py:39    from .tokenizer import PieceSpan
tokenizer.py:541,550     from .gazetteer_anchor import realign_gazetteer_to_pieces   # inside a function
tokenizer.py:566         from .country_lexicon import COUNTRY_FEATURE_DIM, ...       # inside a function
tokenizer.py:583,598     from .gazetteer_anchor import realign_gazetteer_to_pieces   # inside a function
```

Five deferred imports inside `encode_with_features` exist to dodge the cycle. The cause is that `PieceSpan`, the
shared value type, lives in the module that also does the work. An `ImportError` inside `country_lexicon` therefore
raises at first call rather than at import, so a broken module reaches a training run instead of failing at startup.

Their comment claims they keep `tokenizer.py` import-light. Measured, that claim does not hold: `gazetteer_anchor`
adds 2,263 µs and `country_lexicon` 117 µs on top of `tokenizer`'s 36,869 µs, which is 6.5%. Neither module reaches
torch. Deferred imports elsewhere in the tree do buy real weight and stay — see §11.

Both `huggingface/nanotron` and `allenai/OLMo-core` hold value types in a `data/types.py` that everything imports.
A package-root `types.py` holding `PieceSpan` removes all five deferred imports.

### 3.2 `build_jp_slice.py` is the unnamed shared CJK module

| Importer                   | What it takes from `build_jp_slice`                |
| -------------------------- | -------------------------------------------------- |
| `jp_registry.py:32`        | `JP_PREFECTURES`, `normalize_name`, `split_street` |
| `build_tw_slice.py`        | the same helpers                                   |
| `build_kr_slice.py`        | the same helpers                                   |
| `build_cjk_overlay.py`     | the same helpers                                   |
| `build_registry_corpus.py` | the same helpers                                   |

`jp_registry.py` reads a government register and imports a corpus builder to get `normalize_name`. CJK text
normalization has no home, so the first file that needed it became the home: 978 lines of builder that five modules
depend on for four names. A `text/` module owns those names and the dependency points the right way.

This is the failure `AGENTS.md` names for TypeScript under "Before writing a small utility, check whether it already
has a home". Section 9 adds the Python detector.

## 4. The scaling model

`packages/corpus/lib/` already answers "every country":

```
corpus/lib/
├── adapters/  recipes/  synthesizers/  tools/  utils/  test-kit/   roles, cross-country
├── jp/adapters/  jp/tools/                                         the same roles, per country
├── kr/adapters/  kr/tools/
├── us/adapters/  us/tools/  us/fips-state.ts
├── de/recipes/
├── south-asia/recipes/   international/recipes/                    regional grouping
└── build.ts  runner.ts  types.ts  index.ts                         shared entry points
```

Role at the top for cross-country code; the same role names nested under a country key for country-specific code.
A new country adds one directory holding only the roles it needs.

`corpus-python` takes that model with one change: the country keys sit under `countries/` rather than at the package
root. Corpus carries 14 country and region directories among 7 role directories today, and at every country the role
directories stop being findable. One path segment holds the package root at roughly twelve entries permanently.

The key is `countries/`, not `locales/`, because the Python per-country code is keyed by country — register readers,
script-specific text normalization — whereas `locale` in this repository means the `en-US` form that keys the
weights packages and the `--locale` flag.

## 5. What the prefix rule flags

`packages/repo-health/lib/checks/prefix-directories.ts` treats two or more children sharing their first delimited
segment as a family, with the sibling named for the prefix becoming the directory's `index`. Reading `_` for `-`:

| Location                 | Prefix                                                                     | Members         | Destination                                            |
| ------------------------ | -------------------------------------------------------------------------- | --------------- | ------------------------------------------------------ |
| `src/mailwoman_train/`   | `build`                                                                    | 7 files         | `corpora/` plus `countries/<cc>/corpora.py`            |
| `src/mailwoman_train/`   | `tokenizer`                                                                | 3 files         | `tokenizer/`; `tokenizer.py` becomes its `__init__.py` |
| `src/mailwoman_train/`   | `audit`                                                                    | 3 files         | `audits/`                                              |
| `src/mailwoman_train/`   | `jp`                                                                       | 2 files         | `countries/jp/`                                        |
| `src/mailwoman_train/`   | `kr`                                                                       | 2 files         | `countries/kr/`                                        |
| `scripts/`               | `build`                                                                    | 3 files         | `cli/commands/`                                        |
| `scripts/`               | `verify`                                                                   | 2 files         | split; see section 8                                   |
| `tests/mailwoman_train/` | `span`, `tokenizer`, `jp`, `char`, `audit`, `anchor`, `country`, `augment` | 4,3,3,3,3,3,2,2 | mirror the source tree                                 |
| `modal/train_remote.py`  | `sync`                                                                     | 57 functions    | one function over a table                              |
| `modal/train_remote.py`  | `mean`                                                                     | 7 functions     | `init.py`, one function over a table                   |

The target satisfies the rule by construction.

## 6. Target tree: `src/mailwoman_train/`

```
mailwoman_train/
├── __init__.py  __main__.py  py.typed
├── types.py                  PieceSpan and the shared value types (§3.1)
├── protocols.py              declared interfaces
├── labels.py                 55 importers; the most-depended-on module, stays at root
├── config/                   schema.py (the five dataclasses), load.py (merge, coerce, load)
├── cli/
│   └── commands/             one file per subcommand; absorbs fifteen of scripts/
├── data/                     loader, manifest, sources, encode, collate,
│                             augment, relabel, emit, masking, dose
├── text/                     normalize.py, kana.py  (§3.2)
├── tokenizer/                __init__.py (was tokenizer.py), char.py, splice.py, train.py
├── features/                 gazetteer_anchor, country_lexicon, phrase_priors,
│                             postcode_shapes, conventions
├── nn/                       encoder, blocks, char_cnn, heads, crf, span_scorer, serialization
├── optim/                    schedules, groups, fisher
├── train/
│   ├── trainer.py            the loop only
│   ├── noise.py  checkpoint.py  pretrain.py
│   └── callbacks/            console, csv_metrics, evaluator, checkpointer, trackio
├── evaluation/               metrics.py, evaluate.py — NOT `eval/`, see below
├── export/                   onnx.py, quantize.py, package_weights.py
├── corpora/                  builder.py, fragment.py, secondary.py, registry.py
├── audits/                   epoch_mixture, mixed_script, suffix_feed, opening_token
├── observability/            trackio.py
└── countries/
    ├── __init__.py           country code to what that country provides
    ├── jp/  registers.py  corpora.py  kana.py
    ├── kr/  registers.py  corpora.py  juso.py
    ├── tw/  registers.py  corpora.py
    └── cjk/ overlay.py       regional grouping
```

`observability/` rather than `logging/`: a package named `logging` inside a package that also imports the standard
library module of that name is legible to Python and confusing to a reader. `torchtitan` uses the same name.

`evaluation/` rather than `eval/` for the same class of reason, plus a mechanical one. The agent worktree's
write guard refuses any shell command containing that three-letter token, so a directory named exactly that
could not be moved, renamed or removed from a worktree again — the name would have been a one-way door. It also
stops reading as the builtin.

## 7. The extension work

Two pieces, both taken from projects that solved the same problem at larger scale.

**`protocols.py`** declares the interfaces the swappable pieces satisfy — the encoder, a corpus builder, a country's
contribution. `pytorch/torchtitan` keeps these in `protocols/` (`model.py`, `model_spec.py`, `state_dict_adapter.py`)
and the implementations in `components/`. Adding country 40 then means implementing a declared interface rather than
reading `build_jp_slice.py` to infer the expected shape. This is what makes section 4's scaling model usable rather
than merely tidy.

**`train/callbacks/`** follows `allenai/OLMo-core`, which carries 22 callback modules, one per concern. `train()`'s
476 lines become a loop plus five callbacks: console logging, the CSV row (`eval_csv_row`), the periodic evaluation
(`_eval_val`), checkpointing (`save_checkpoint`), and trackio. Each becomes independently testable; none of them is
today.

## 8. Target tree: `launch/`

### 8.1 The rename is forced

Measured on this branch:

```
$ cd corpus-python && uv run python -c "import sys; sys.path.insert(0,'.'); import modal; print('resolved to:', modal.__file__)"
resolved to: None
```

`None` means `import modal` resolved to the local `corpus-python/modal/` directory as a namespace package, shadowing
the Modal SDK. It works today because `modal run corpus-python/modal/train_remote.py` executes one file as a script,
which puts `corpus-python/modal/` on `sys.path` rather than `corpus-python/`.

Splitting that file requires Modal's module mode: an `__init__.py` importing every member module so the decorated
functions register, invoked as `modal run -m <pkg>.<mod>`. That makes it a real package on `sys.path`, and the
shadowing becomes live. The directory is therefore renamed to `launch/`, which is `OLMo-core`'s name for the same
role.

### 8.2 The shape

```
launch/
├── __init__.py           imports every member so functions register
├── app.py                app, volume, image, secrets, constants
├── env.py                the four _load_* helpers
├── corpora.py            the table: one entry per corpus version
├── sync.py               one sync function over that table
├── init.py               one mean-init function over a table
├── train.py  export.py
└── diagnostics/          digit_prior, piece_prior, corpus, de_eval, evidence_bundle,
                          street_type_contrast, suffix_plasticity
```

Each table entry carries what a clone varies: the version string, the rclone source and destination pairs, and the
paths its verify block checks.

### 8.3 The duplication is a documented instruction

`corpus-python/modal/AGENTS.md` step 4 reads: "Add a `sync_v0XX` to `train_remote.py`, mirroring `sync_v050`." The 57
clones follow the runbook. That step is rewritten from "add a function" to "add a row", or the next corpus version
adds clone 58.

### 8.4 This part has no test coverage

No test imports `modal/train_remote.py`. Only `test_verify_toolchain.py` reaches `scripts/`. So the 983 tests passing
after the collapse carries no information about the collapse.

Before collapsing: a test that generates the command set and the check list for all 57 versions and compares them
against the literal strings extracted from the current file. The collapse lands only against that test.

### 8.5 Call sites

`modal run corpus-python/modal/train_remote.py::sync_v560_bare_postcode` becomes
`modal run -m launch.sync --version v5.6.0`. The old string appears in `REPRODUCIBILITY.md:28,31`,
`packages/mailwoman/lib/dev-tools/verify-export-quant-versions.run.ts:24`, `modal/AGENTS.md`, the `night-shift` and
`training-arc` skills, and the fixture strings in `packages/dev-mcp/test/unit/bash-write-guard.test.ts`. The compiler
reads none of them, so they are swept as quoted literals per the "Moving a workspace" rule in `AGENTS.md`.

The Bash write guard is unaffected: `packages/dev-mcp/lib/hooks/bash/write/rules.ts:196` matches `head: "modal"`, not
a filename.

### 8.6 `scripts/`

Fifteen of seventeen become `cli/commands/` subcommands, giving one entry point instead of two conventions, and the
two kebab-case files (`fit-isotonic-calibration.py`, `calibration-drift-guard.py`) get importable names.

`verify_toolchain.py` stays a standalone script. Its imports are `importlib.metadata`, `re`, `sys`, `tomllib` and
`pathlib` — standard library only — and `.husky/pre-commit:63` with `package.json:54` invoke it as bare `python3`
with no `uv run` and no environment. Folding it into the CLI would make the pre-commit hook depend on a synced venv.

## 9. Packaging and enforcement

- Add `py.typed`. `mypy --strict` runs over `src/` today and the marker is absent, so the strictness is claimed and
  not exported.
- Widen `[tool.mypy] files` from `["src"]` to include `launch/`, which this arc rewrites anyway.
  `tests/` stays out: `uv run mypy --strict tests` reports 663 errors in 54 of 56 files on this branch, so admitting
  it is its own arc, not a line in this one.
- Delete `src/mailwoman_corpus/`: zero importers, a docstring and a `__version__`.
- Add a Python counterpart of `prefix-directories` to `repo-health`, so section 5 stays satisfied. The Python tree is
  outside every structural check the repository runs, which is why section 3's two defects went unreported.

## 10. Sequencing

Each step ends green on the 983 tests, which run in 29.6 s, so every step is independently revertible.

1. `types.py`; remove the five deferred imports.
2. `text/`; repoint the five importers off `build_jp_slice`.
3. Role directories, module by module, in dependency order: `labels`, `config`, `data`, `nn`, `optim`, `train`.
4. Split `model.__init__`, `model.forward`, and `train()`.
5. `protocols.py`, then `train/callbacks/`.
6. `countries/` and the country registry.
7. `scripts/` to `cli/commands/`.
8. Write the launch-table test; rename `modal/` to `launch/`; collapse the 57 and the 7.
9. Mirror `tests/`; sweep quoted literals; add the Python prefix check; `py.typed`; widen mypy; delete
   `mailwoman_corpus`.

Steps 1 through 7 touch nothing a Modal run reads before merge. Step 8 changes every launch command, so it runs last.

## 11. Acceptance criteria

- `uv run --extra dev --extra train pytest tests -q` reports at least 983 passed at every step.
- `uv run mypy`, `uvx ruff@0.16.5 check corpus-python`, `uvx ruff@0.16.5 format --check corpus-python` and
  `uv run bandit -c pyproject.toml -r src` pass.
- `yarn health` and root `yarn test` pass; the quoted-literal sweep reports no stale `train_remote.py` path in a
  tracked file.
- No module in `src/mailwoman_train/` exceeds 500 lines; no function exceeds 120. Two modules sit near the line and
  decide where the threshold lands: `config.py`'s dataclass block is 478 lines and moves to `config/schema.py`
  under it; `tokenizer.py` is 609 and must therefore split further than a rename into `tokenizer/__init__.py`.
- The Python prefix check reports zero groups.
- No intra-package import inside a function body names a module that transitively imports the module holding it.
  That is the §3.1 regression detector, and it flags a cycle rather than every deferred import.

  A deferred import is not a defect on its own. Measured on this branch: `mailwoman_train.cli` imports in 22,340 µs
  while `mailwoman_train.train` takes 1,458,740 µs, so the 32 deferred imports in `cli.py` keep torch's 1.46 s off
  every `--help`. Of the 63 deferred intra-package imports in the tree, five are cycle-dodgers — `tokenizer.py` at
  541, 550, 566, 583 and 598 — and the other 58 buy startup weight.

- A corpus version is added to `launch/corpora.py` as one table row, verified by adding the most recent existing
  version through the new path and diffing the generated command set against the current literal strings.

## 12. Deliberately out of scope

- `config.py`'s loader semantics. It moves and is not rewritten.
- The `configs/*.yaml` recipe files. They are named by running and queued jobs.
- `corpus-python/` as a directory name. It is a string in `package.json`, `.husky/pre-commit`,
  `.github/workflows/test.yml`, `knip.json`, `oxlint.config.ts`, `.github/dependabot.yml`, `REPRODUCIBILITY.md`, and
  the R2 bucket layout that `launch/sync.py` reads.
- Any training run. Nothing here launches one.
