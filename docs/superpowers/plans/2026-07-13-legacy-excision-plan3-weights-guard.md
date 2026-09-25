# Legacy Excision Plan 3 — CLI Weights Guard Implementation Plan

> **Execution mode:** The session lead executes this plan inline without subagents (operator-directed, 2026-07-13). Tasks keep TDD discipline and per-task commits. The code lives in the executor's context rather than verbatim in this doc.

**Goal:** `npx mailwoman parse "1600 Amphitheatre Parkway, Mountain View, CA 94043"` should work with zero setup. When weights are missing, the CLI prompts for an interactive download into a user cache. If the user declines, the CLI runs the real pipeline in degraded (encoder-less) structural mode and prints a banner. Scripts stay deterministic with `--download-weights` or `--degraded`.

**Spec:** `docs/superpowers/specs/2026-07-12-legacy-rules-excision-design.md` §Weights guard. This is plan 3 of 5. It does not depend on the check-blocked plan-2 swaps, because it guards weight _presence_ rather than parse quality.

**Pre-v7 scoping (deliberate):** The guard is additive. Non-interactive runs with absent weights keep today's behavior (silent fallback chain, rules via `runIsolated`) until plan 4 turns that branch into a hard error. The `declined` path goes straight to the spec's degraded mode. That mode is the pipeline-without-classifier composition that `parse.tsx:362-372` documents and then bypasses today.

## Design (settled by direct source survey, 2026-07-13)

- **The cache is an npm prefix:** `~/.cache/mailwoman/weights`, found via `os.homedir()` rather than a raw env read. The download delegates to the user's own `npm install --prefix <cache> @mailwoman/neural-weights-<locale>@<cli-version>`, which supplies integrity checks, proxy and registry config, and its own child PID. The version is pinned to the running CLI. The download falls back to `@latest` when the pinned version returns 404.
- **Metadata-only tarballs:** Code-only releases publish weights packages without binaries (`MAILWOMAN_SKIP_WEIGHTS_COPY`). After install, the guard probes for `model.onnx` and `tokenizer.model`. A binary-less install produces a visible, actionable error instead of a success. The durable fix is a publish-workflow `weights-latest` dist-tag, which is filed as a board issue and out of scope here.
- **Resolution gains one fallback branch:** `neural/weights.ts` gets `resolveFromPackageDir(packageDir, …)`, extracted from the existing package branch. Sibling artifacts (model card, CRF, anchor bin, gazetteer lexicon) then resolve the same way for cache installs. The explicit-paths branch still resolves no siblings, and that missing-sibling case is the degraded-quality problem the cache layout avoids. `resolveWeights` tries explicit paths, then the `require.resolve` package, then the cache prefix (`<cache>/node_modules/@mailwoman/neural-weights-<locale>`). If all fail, its error lists every tried path, including the cache. Tests inject the cache location through an optional `cacheRoot` option.
- **Guard component** `mailwoman/cli-kit/weights-guard.tsx` follows the AuthGuard wrapper pattern:
  - Weights present: pass through as `neural`.
  - Weights absent and stdin supports raw mode: show a Y/n prompt (ink `useInput`). On accept, spawn the download with live status, re-probe, and return `neural`. On decline or download failure, return `declined`.
  - Weights absent and non-interactive: return `unavailable`, and the caller keeps the legacy chain.
  - Flags skip the prompt. `--download-weights` accepts automatically, and `--degraded` goes straight to declined-mode output.
- **Degraded runner:** `createRuntimePipeline({})` runs the real stages without the encoder and serializes output like the normal path. It also prints a stderr banner that says what is degraded and gives both upgrade paths (install the package, or rerun with `--download-weights`). stdout stays machine-parseable.

## Tasks

### Task 1: `resolveWeights` cache fallback (`neural/weights.ts` + `neural/test/weights-cache.test.ts`)

- Extract `resolveFromPackageDir`. Add `cacheRoot?: string` to `ResolveWeightsOpts` (default `~/.cache/mailwoman/weights`). Probe the cache prefix after package resolution fails. Export `weightsCacheDir()` and the package-name builder so the guard can reuse them.
- TDD: Build a tmp-dir cache layout with stub `model.onnx`, `tokenizer.model`, and `model-card.json`, plus a `postcode-us.bin` to prove sibling resolution. It should resolve with `source: "cache:@mailwoman/neural-weights-en-us"`. When the weights are absent everywhere, the error message should include the cache path.
- Receipts: the new test passes, the existing `yarn vitest --run neural/test/weights.test.ts` passes, and `yarn tsc -b neural` passes.

### Task 2: guard implementation (`mailwoman/cli-kit/weights-guard.tsx` + test)

- Implement these parts:
  - `probeWeights(locale, cacheRoot?)` wraps `resolveWeights` in try/catch and returns a boolean plus detail.
  - `buildWeightsInstallArgs(locale, version, cacheRoot)` is pure and tested.
  - `downloadWeights(opts, onStatus)` spawns npm and returns a promise of the probe-after-install result.
  - The `WeightsGuard` component has outcomes `neural | declined | unavailable` and the prompt, downloading, and error states.
- TDD covers the pure parts: the args builder, including version pinning and the `@latest` fallback, and the probe against the Task 1 tmp cache. Tests exercise component states by invoking the render prop directly, without adding an ink-testing dependency.
- Receipts: tests pass, and `yarn tsc -b` passes.

### Task 3: `parse.tsx` wiring (+ flags)

- Add the flags `downloadWeights` and `degraded` (bool, using the `.optional().default(false)` idiom).
- Change the default path only:
  - Probe before `useCommandTask`.
  - Wrap the task in `WeightsGuard` when weights are absent and the session is interactive or flagged.
  - Route `declined` and `--degraded` to `runDegraded`, which runs the pipeline without the classifier and prints the stderr banner.
  - Leave the legacy chain untouched for `unavailable`.
  - Leave the `--isolated`, `--model`, `--benchmark`, and `--noNeural` paths unguarded.
- Receipts: `yarn compile` passes, flag help renders, and existing parse tests pass.

### Task 4: live verification (lab host) + board issue

- Run the e2e cache flow against the real registry. Use a scratch `cacheRoot` rather than the real `~/.cache`. `npm install --prefix` the published weights, confirm that `resolveWeights({cacheRoot})` resolves the weights and sibling artifacts, and confirm that the classifier loads and parses.
- Test the interactive prompt under a pty (`script -qec … /dev/null` with piped `n\n` or `y\n`). Declining should render degraded output and the banner. `--degraded` and `--download-weights` should behave non-interactively.
- Test the binary-less-install probe. Point the pin at a known metadata-only version, or simulate one by removing `model.onnx` from the scratch install. The CLI should print actionable error text.
- ~~File the dist-tag board issue~~ Executor finding (2026-07-13): `npm view` shows that the 5.10.0 and 6.0.0 weights tarballs are both about 40 MB. Code-only releases do ship binaries, because the publish flow stages them regardless of `release_weights`. The registry has no metadata-only weights tarball. The post-install probe stays as defense in depth, and no issue was filed.
- Receipts: transcripts of all four checks in the PR body, `yarn tsc -b`, and a full `yarn vitest --run` over the touched workspaces.

### Task 5: PR

- Push `feat/weights-guard` (branched off main) and open a PR with receipts. CI must pass without skips, so every new test uses tmp fixtures and runs without weights.

## Acceptance

1. Fresh-machine simulation (an empty scratch cache without a weights package): The TTY prompt appears. `y` downloads the weights and parses neurally. `n` prints degraded JSON and the stderr banner. Both paths exit 0.
2. Non-TTY behavior with absent weights is byte-identical to today's (pre-v7 guarantee).
3. When every resolution path fails, the `resolveWeights` error text includes the cache path.
4. The change adds no raw `process.env` or `process.argv` reads, adds no runtime dependencies, and leaves both export maps untouched (no new subpaths).
