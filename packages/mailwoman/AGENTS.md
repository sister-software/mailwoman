# AGENTS.md — `mailwoman`

Read the repository-root `AGENTS.md` first.

CLI helpers live in `lib/cli/kit/`. Parser test helpers live in `lib/test-kit/`. Neither belongs under
`sdk/`, which the repository reserves for data acquisition.

## Terminal output tests

Strip ANSI control sequences with `stripAnsi` from `mailwoman/cli-kit` before matching rendered output.
Chalk follows `FORCE_COLOR`, so a raw capture has colored and uncolored forms. Escape sequences can split
whitespace matches and can make a negative assertion pass even when the prohibited text is present.

Run a relevant terminal-output test with `FORCE_COLOR=3` when adding or changing an assertion. Match the
plain result after stripping ANSI.

## Interactive Ink tests

PTY probes that inspect frame history must call `render(node, { interactive: true })`. Ink resolves
interactivity from both CI detection and `stdout.isTTY`; CI detection overrides a real PTY. Without the
explicit option, Ink writes only the final frame at unmount and a readiness wait can consume its full
timeout.

`lib/debug-view/test/input-probe.ts` is the reference implementation. The corresponding PTY test fell
from 42 seconds to 2.8 seconds after the probe forced interactive rendering.
