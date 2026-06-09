# Operations

:::tip[Audience]

🧪 **Operator documentation.** For contributors running corpus builds, training experiments, and releases. If you want to use Mailwoman, see [Getting started](/docs/getting-started).

:::

## Working norms

You are an autonomous agent. Optimize for **legibility to a human checking in once a day**, not for clever one-shot completions.

### Pacing

- Work in small, complete units. A "unit" is anything that ends with a green test suite or a working command.
- Commit at every unit boundary. Better too many commits than too few.
- Do not start Phase N+1 until Phase N's success criteria checklist is fully green and committed.

### Decision discipline

When you hit a fork in the road:

1. If the plan answers it: follow the plan.
2. If the plan is silent and the decision is **reversible** (file naming, test structure, internal variable names): pick the most conventional option and move on.
3. If the plan is silent and the decision is **hard to reverse** (public API surface, schema change, npm package name, license commitment, data format): write the decision and the alternatives to `DECISIONS.md` and pick the most conservative option (the one that preserves the most future options).
4. Never block waiting for input. If a decision feels truly blocking, write it to `DECISIONS.md` under a `## BLOCKED` heading and continue with adjacent work.

### Commit messages

Format:

```
<phase>: <terse imperative>

<optional body: rationale, what changed, what didn't>

Refs: <plan file paths if relevant>
```

Example:

```
phase-0: wrap legacy classifiers in ClassificationProposal adapter

All existing rule classifiers now route through wrapLegacyClassifier.
Output shape is identical to pre-refactor for SDK consumers.
Solver code untouched.

Refs: reference/INTERFACES.md, phases/PHASE_0_foundation.md §3
```

### Branching

- Work on a branch named `neural/phase-N-<slug>` per phase.
- Squash-merge to `main` at phase completion.
- Tag `main` at each phase completion: `neural-phase-N-complete`.

## Progress reporting

### `LOG.md`

Append-only, one line per meaningful event. Format:

```
YYYY-MM-DD HH:MM | phase-N | <what was done> | <next>
```

Examples:

```
2026-05-16 14:30 | phase-0 | added ComponentTag union, BIO_LABELS derivation, 47 unit tests passing | wrap rule classifiers
2026-05-16 16:05 | phase-0 | wrapped 12 rule classifiers via adapter, zero behavior change | ClassifierPolicy registry
2026-05-17 09:12 | phase-1 | OSM PBF adapter streams 100k rows in 38s, memory steady at 220MB | WOF admin adapter
```

Keep it terse. The radio-console format.

### `DECISIONS.md`

Decisions that affect future code. One entry per decision. Format:

```
## YYYY-MM-DD — <decision title>

**Context:** what was being done

**Options considered:**
1. <option> — pros, cons
2. <option> — pros, cons

**Chosen:** <option>

**Rationale:** <one paragraph>

**Reversibility:** <reversible | costly | irreversible>
```

### `BLOCKERS.md`

Only created if you have a genuine blocker. One entry per blocker.

```
## YYYY-MM-DD — <blocker title>

**What's blocked:** <task>
**Why:** <reason>
**What you tried:** <attempts>
**What would unblock:** <answer needed / resource needed / decision needed>
```

Always continue with adjacent work while a blocker is open. Do not idle.

## Code quality

### Tests

- Unit tests for every classifier (rule and neural alike).
- Integration tests for every adapter against a small fixture in `corpus/fixtures/`.
- Golden-set tests for the full pipeline. Regression here blocks merge.
- Use Vitest (already in Mailwoman).

### Types

- Strict TypeScript. `strict: true` in every package.
- No `any`. Use `unknown` and narrow.
- Public API exports must have explicit type annotations.

### Linting and formatting

- ESLint (already in Mailwoman). Run on every commit.
- Prettier (already in Mailwoman). Run on every commit.
- Add a pre-commit hook via Husky (already present) if not already enforced.

### Performance budgets

| Path                                  | Budget     |
| ------------------------------------- | ---------- |
| Rule-only classify, single address    | < 5ms p95  |
| Neural classify, single address, CPU  | < 20ms p95 |
| Neural classify, single address, GPU  | < 5ms p95  |
| Cold model load                       | < 2s       |
| Tokenizer parity check, 10k addresses | < 30s      |

If a change blows a budget, profile before optimizing. Add a microbenchmark to `bench/` so the regression doesn't return.

## Dependencies

Adding a dependency requires:

1. Justification in the commit message (why this, why not X, why not a few lines of code).
2. License check — must be MIT, Apache-2.0, BSD, or ISC. AGPL-compatible licenses fine for the package itself (Mailwoman is AGPL) but verify case-by-case.
3. Size check — flag in commit if it adds > 1MB to bundled output.
4. Stewardship check — verify the dep is actively maintained (commit in last 12 months, > 1 maintainer or > 100 stars).

Approved dependencies for this project:

- `onnxruntime-node` — ONNX inference
- `@bloomberg/sentencepiece-wasm` (or equivalent) — SentencePiece tokenization in JS. Verify and pick.
- `@dsnp/parquetjs` — Parquet read/write in TS
- `osm-pbf-parser-node` (or equivalent) — OSM PBF streaming. Verify and pick.
- `better-sqlite3` — for WOF SQLite reads
- `fast-csv` — CSV parsing for government data
- `fastest-levenshtein` — alignment fuzzy matching
- Existing Mailwoman deps — all retained

## Data handling

### Storage layout in the home lab

```
/data/
  corpus/
    sources/           # raw downloads, never modified
      osm/
      wof/
      ban/
      openaddresses/
      usgov/
    intermediate/      # adapter outputs before alignment
    aligned/           # post-alignment Parquet shards
    versioned/         # frozen corpus versions, e.g. corpus-v0.1.0/
  models/
    checkpoints/       # PyTorch training checkpoints
    onnx/              # exported ONNX models
    quantized/         # int8 quantized models
  eval/
    golden/            # hand-labeled golden set, locked, versioned
    splits/            # train/val/test split manifests
```

### Versioning

- Corpus versions: `corpus-v<major>.<minor>.<patch>`. Major = schema change. Minor = source added. Patch = synthesis tweak.
- Model versions: `model-v<major>.<minor>.<patch>-<locale>`. Same scheme.
- Both versions appear in `ModelCard.trainedOn` and `LabeledRow.corpus_version` so any prediction is traceable to its training data.

### What never goes in git

- Raw source data (too large, redistribution risk for some sources)
- Trained model checkpoints over 100MB (use Git LFS or external storage)
- Anything containing PII

What goes in git:

- All code
- Corpus manifests (file lists + checksums, not the files)
- Eval splits (lists of source IDs in each split)
- The hand-labeled golden set (small, human-verified)
- Adapter fixtures (small, hand-crafted, license-clean)

## Communication with the human

The human checks in periodically. They will read:

1. `LOG.md` first
2. `DECISIONS.md` if `LOG.md` references a decision
3. `BLOCKERS.md` if you have one open
4. The actual code only if something looks off in the logs

Write logs assuming the reader hasn't seen the code yet. "Wrapped 12 rule classifiers" is fine. "Refactored the thing" is not.

When the human asks a question, answer in the radio-console format (see user preferences they've set). Lead with `→`. No greetings.

## When you finish a phase

1. Run the full test suite. Green.
2. Run benchmarks. Within budget.
3. Update `LOG.md` with phase-complete entry.
4. Squash-merge the phase branch to `main`.
5. Tag `main`: `git tag neural-phase-N-complete && git push --tags`.
6. Open `phases/PHASE_<N+1>_*.md` and begin.

## When you finish all phases

Do not "polish" indefinitely. Write a final entry in `LOG.md` saying phase 6 is complete, run one final test pass, push, and stop. The human will pick it up from there.
