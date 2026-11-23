# AGENTS.md — `mailwoman`

Read the repository-root `AGENTS.md` first.

The package has three source roots. `lib/` holds the library, including the parser test helpers in
`lib/test-kit/`. `cli/` holds the command-line program: `cli/main.ts`, the file-routed `cli/commands/`
tree, and the CLI helpers in `cli/kit/`. `tools/` holds evaluation, build and maintenance code such as
`tools/eval-harness/` and `tools/dev-tools/`. Library code never imports `cli/` or `tools/`.

`lib/package/metadata.ts` owns `readMailwomanManifest()`, the single read of this package's own
`package.json` for its version, engines floor, and license.

## Library layout

The `lib/` root holds `index.ts`, `env.ts` and the sibling file of a directory. Every other module
lives in the directory of its role:

- `engine/` builds what a caller runs: the parser, the runtime pipeline, the resolver backend and the serve engine.
- `parse/` holds the steps the runtime pipeline runs on a decoded tree.
- `geocode/` holds the geocode cascade. Its directories are `rewrites/` (tree rewrites after the decode),
  `scope/` (the country scope), `intent/` (query-intent markers), `result/` (what a geocode adds to its result),
  `layers/` (the data layers a session opens), `session/`, `options/` and `batch/` (geocoding a stream of records).
- `data/` holds the data root's installer. Its directories are `published/` (what the public bucket offers),
  `install/` (acquire, plan, build and prune), `catalog/` (the installed artifacts) and `terms/` (license and sources).
- `diagnostics/` holds what a check or a server reports about the running process.
- `package/` reads this package's own manifest.

## Tools layout

`tools/dev-tools/` and `tools/eval-harness/` hold zero modules directly. A tool lives in the directory of
the step it performs, the label it studies, or the country it covers:

- `tools/dev-tools/` steps: `board/` (gauntlet board upkeep), `census/` (report-only counts), `evaluation/`,
  `benchmark/`, `smoke/`, `arenas/`, `probe/` (two-model probes), `calibration/`, `candidate-cache/`,
  `coordinate/` (coordinate boards), `legacy-parity/`, `generate/`, `jurisdiction/`, `repository/`, `host/`,
  `build/`, `score/`, `corpus/`, `codex/`, `data/`.
- `tools/dev-tools/labels/<label>/` holds the tools about one `ComponentTag`, spelled as the tag with a
  hyphen for an underscore: `labels/locality/`, `labels/postcode/`. A tool with both a step and a label
  sits under its step, as `corpus/labels/street/` does.
- `tools/dev-tools/<cc>/` holds one country's tools.
- `tools/eval-harness/`: `board/` (the boards a run grades), `evaluation/` (one evaluation a command runs),
  `rig/` (what a run is set up with), `capability/`, `parity/`, `preregistration/` and `ledger/`.

A `*.run.ts` entry is started by its path, which the compiler never reads. After moving one, search
`resolvePackagePath` calls, workflows, skills, `AGENTS.md` files and `docs/` for the old path.

## CLI commands

The CLI runs as `node packages/mailwoman/out/cli/main.js` and never from source. Its Ink commands are
`.tsx`, Node's type stripping handles `.ts` only, and `npx tsx` ignores the tsconfig `jsx` setting and
fails with `React is not defined`. The CLI integration tests under `cli/commands/*.integration.test.ts`
exec that compiled entry through `execFileSync(process.execPath, …)`. Run `yarn compile` before the
suite after a fresh checkout, a branch switch or a dependency change. A stale `out/` fails on a
recently added flag (`option '--format' argument … is invalid`) or silently passes against old code.

A command module exports a `spec`, a `CommandSpec` from `cli/native/spec.ts`, and a default Ink
component. The router in `cli/native/command/router.ts` resolves the typed command to one compiled
module under `out/cli/commands/` and imports that module only. A command's top-level imports therefore
load on every run of that command. An optional peer or a heavy dependency belongs behind an
`await import()` in the branch that needs it, or a run that never reaches the branch pays for it, and
an uninstalled optional peer fails the command at import. `mw --help` and a group's help list
commands by reading each module's text for its declared name, without importing it. Option keys
arrive camelCase (`options.dryRun`). When a command keeps several sibling modules behind one
choice, such as `corpus fetch <source>`, it keeps a table of entries that each import their own
module, and `satisfies Record<…>` keeps the table complete against the choices.

A command reports a long-running library's `onProgress` or `onPhase` through `useStageProgress` in
`cli/kit/progress.ts`, never through its own React state or `console.error`, so a detached run with stdout
redirected logs each stage to stderr as a timestamped line while it runs rather than only Ink's final frame at
exit. Pass `progress.report` for a `(phase, detail?)` callback and `progress.stage(name)` for a `(detail)` one,
and hand `progress` to `CommandTaskResult` to draw the stage line. A library reports its phase and detail
unformatted. The hook adds the brackets.

`percentile` and `median` in core use nearest-rank semantics matched to the promotion eval. Keep
those semantics. Declare a boolean positively with `default: true`; `cli/native/spec.ts` parses
with `allowNegative`, so an option declared as `no-x` never binds (`--no-x` sets `x: false`) and help
renders `--[no-]x`. A factory-built command `spec` is invisible to the static option-collision test.

## Terminal output tests

Strip ANSI control sequences with `stripANSI` from `@mailwoman/core/strings/terminal` before matching rendered output.
Chalk follows `FORCE_COLOR`, so a raw capture has colored and uncolored forms. Escape sequences can split
whitespace matches and can make a negative assertion pass even when the prohibited text is present.

Run a relevant terminal-output test with `FORCE_COLOR=3` when adding or changing an assertion. Match the
plain result after stripping ANSI.

## Interactive Ink tests

PTY probes that inspect frame history must call `render(node, { interactive: true })`. Ink resolves
interactivity from both CI detection and `stdout.isTTY`; CI detection overrides a real PTY. Without the
explicit option, Ink writes only the final frame at unmount and a readiness wait can consume its full
timeout.

`cli/debug-view/test/input-probe.ts` is the reference implementation. The corresponding PTY test fell
from 42 seconds to 2.8 seconds after the probe forced interactive rendering.
