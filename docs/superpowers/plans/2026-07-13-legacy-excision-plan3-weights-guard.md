# Legacy Excision Plan 3 — CLI Weights Guard Implementation Plan

> **Execution mode:** inline by the session lead (operator-directed, 2026-07-13) — no subagents. Tasks keep TDD discipline and per-task commits; code lives in the executor's context rather than verbatim in this doc.

**Goal:** `npx mailwoman parse "1600 Amphitheatre Parkway, Mountain View, CA 94043"` keeps feeling good with zero setup: missing weights prompt an interactive download into a user cache; declining runs the real pipeline in degraded (encoder-less) structural mode with a banner; scripts stay deterministic via `--download-weights` / `--degraded`.

**Spec:** `docs/superpowers/specs/2026-07-12-legacy-rules-excision-design.md` §Weights guard. Plan 3 of 5 — independent of the gate-blocked plan-2 swaps (this guards weight _presence_, not parse quality).

**Pre-v7 scoping (deliberate):** the guard is additive. Non-interactive runs with absent weights keep today's behavior (silent fallback chain, rules via `runIsolated`) until plan 4 flips that branch to a hard error. The `declined` path goes straight to the spec's degraded mode — the pipeline-without-classifier composition that `parse.tsx:362-372` documents and then bypasses today.

## Design (settled by direct source survey, 2026-07-13)

- **Cache = an npm prefix:** `~/.cache/mailwoman/weights` (via `os.homedir()` — no raw env). Download delegates to the user's own `npm install --prefix <cache> @mailwoman/neural-weights-<locale>@<cli-version>` (integrity, proxy, registry config for free; own child PID). Version-pinned to the running CLI; fall back to `@latest` when the pinned version 404s.
- **Metadata-only-tarball trap:** code-only releases publish weights packages WITHOUT binaries (`MAILWOMAN_SKIP_WEIGHTS_COPY`). After install, PROBE `model.onnx` + `tokenizer.model`; a binary-less install is a loud, actionable error, not a success. Durable fix is a publish-workflow `weights-latest` dist-tag — filed as a board issue, out of scope here.
- **Resolution learns ONE fallback branch:** `neural/weights.ts` gets `resolveFromPackageDir(packageDir, …)` extracted from the existing package branch (sibling artifacts — model-card, CRF, anchor bin, gazetteer lexicon — resolve identically for cache installs; the explicit-paths branch stays sibling-less, which is exactly the degraded-quality trap the cache layout avoids). `resolveWeights` order: explicit paths → `require.resolve` package → cache prefix (`<cache>/node_modules/@mailwoman/neural-weights-<locale>`) → error naming ALL tried paths including the cache. Test seam: optional `cacheRoot` opt.
- **Guard component** `mailwoman/cli-kit/weights-guard.tsx` (AuthGuard-wrapper pattern): probe → `neural` passthrough; absent + raw-mode-capable stdin → Y/n prompt (ink `useInput`) → accept: spawn download with live status → re-probe → `neural`; decline/download-failure → `declined`; absent + non-interactive → `unavailable` (caller keeps legacy chain). Flags short-circuit the prompt: `--download-weights` ⇒ auto-accept, `--degraded` ⇒ straight to declined-mode output.
- **Degraded runner:** `createRuntimePipeline({})` — the real stages minus the encoder — serialized like the normal path, plus a stderr banner naming what's degraded and both upgrade paths (install the package / rerun with `--download-weights`). stdout stays machine-parseable.

## Tasks

### Task 1: `resolveWeights` cache fallback (`neural/weights.ts` + `neural/test/weights-cache.test.ts`)

- Extract `resolveFromPackageDir`; add `cacheRoot?: string` to `ResolveWeightsOpts` (default `~/.cache/mailwoman/weights`); probe the cache prefix after package resolution fails; export `weightsCacheDir()` and the package-name builder for the guard's reuse.
- TDD: tmp-dir cache layout with stub `model.onnx`/`tokenizer.model`/`model-card.json` (+ a `postcode-us.bin` to prove sibling resolution) → resolves with `source: "cache:@mailwoman/neural-weights-en-us"`; absent everywhere → error message names the cache path.
- Receipts: new test green, `yarn vitest --run neural/test/weights.test.ts` (existing) green, `yarn tsc -b neural`.

### Task 2: guard machinery (`mailwoman/cli-kit/weights-guard.tsx` + test)

- `probeWeights(locale, cacheRoot?)` (resolveWeights try/catch → boolean+detail), `buildWeightsInstallArgs(locale, version, cacheRoot)` (pure, tested), `downloadWeights(opts, onStatus)` (spawn npm, promise of probe-after-install result), `WeightsGuard` component with outcomes `neural | declined | unavailable` and the prompt/downloading/error states.
- TDD on the pure parts (args builder incl. version pin + latest fallback semantics, probe against the Task-1 tmp cache); component states exercised via direct render-prop invocation (no ink-testing dep added).
- Receipts: tests green, `yarn tsc -b`.

### Task 3: `parse.tsx` wiring (+ flags)

- New flags: `downloadWeights` / `degraded` (bool, `.optional().default(false)` idiom).
- Default path only: probe before `useCommandTask`; wrap the task in `WeightsGuard` when absent + interactive-or-flagged; `declined`/`--degraded` → `runDegraded` (pipeline sans classifier + stderr banner); `unavailable` → legacy chain untouched; `--isolated`/`--model`/`--benchmark`/`--noNeural` paths never guarded.
- Receipts: `yarn compile`; flag help renders; existing parse tests green.

### Task 4: live verification (lab host) + board issue

- e2e cache flow with the REAL registry: scratch `cacheRoot` → `npm install --prefix` the published weights → `resolveWeights({cacheRoot})` resolves incl. sibling artifacts → classifier loads and parses. (Uses a scratch dir, not the real `~/.cache`.)
- Interactive prompt under a pty (`script -qec … /dev/null` with piped `n\n` / `y\n`): decline renders degraded output + banner; `--degraded` and `--download-weights` behave non-interactively.
- Binary-less-install probe: point the pin at a known metadata-only version (or simulate by removing `model.onnx` from the scratch install) → actionable error text.
- ~~File the dist-tag board issue~~ Executor finding (2026-07-13): npm view shows 5.10.0 AND 6.0.0 weights tarballs both ~40 MB — code-only releases DO ship binaries (the publish flow stages them regardless of release_weights). The metadata-only trap is not observed on the registry; the post-install probe stays as defense-in-depth, no issue filed.
- Receipts: transcripts of all four in the PR body; `yarn tsc -b`; full `yarn vitest --run` over touched workspaces.

### Task 5: PR

- Push `feat/weights-guard` (branched off main), PR with receipts. CI-green requirement: all new tests are weights-independent (tmp fixtures) — nothing skips.

## Acceptance

1. Fresh-machine simulation (empty scratch cache, no weights package): TTY prompt appears; `y` downloads + parses neurally; `n` prints degraded JSON + stderr banner; exit 0 both ways.
2. Non-TTY absent-weights behavior is byte-identical to today's (pre-v7 guarantee).
3. `resolveWeights` error text names the cache path when everything misses.
4. No raw `process.env`/`process.argv`; no new runtime deps; both export maps untouched (no new subpaths).
