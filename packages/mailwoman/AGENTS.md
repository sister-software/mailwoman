# AGENTS.md — `mailwoman`

Read the repository-root `AGENTS.md` first.

The package has three source roots. `lib/` holds the library, including the parser test helpers in
`lib/test-kit/`. `cli/` holds the command-line program: `cli/main.ts`, the file-routed `cli/commands/`
tree, and the CLI helpers in `cli/kit/`. `tools/` holds evaluation, build and maintenance code such as
`tools/eval-harness/` and `tools/dev-tools/`. Library code never imports `cli/` or `tools/`.

`lib/metadata.ts` owns `readMailwomanManifest()`, the single read of this package's own
`package.json` for its version, engines floor, and license.

## Terminal output tests

Strip ANSI control sequences with `stripAnsi` from `mailwoman/cli/kit` before matching rendered output.
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
