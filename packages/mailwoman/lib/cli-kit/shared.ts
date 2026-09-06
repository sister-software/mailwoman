/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The command toolkit for `mailwoman/commands/*` — Ink helper types, the one-shot
 *   {@linkcode useCommandTask} runner, and the {@linkcode CheckList} renderer. Lives OUTSIDE
 *   `commands/` (the router treats every file there as a command) and OUTSIDE `sdk/` (`sdk/` submodules
 *   mean data acquisition). Built with `createElement`, not JSX, so the module stays plain `.ts` —
 *   importable under node's type stripping (the dev `node →` exports condition).
 */

// Never the `@mailwoman/core` barrel: this is shared by every interactive command, and the barrel needlessly widens
// each selected command's import graph.
import { prettyJSON } from "@mailwoman/core/json"
import { type PlacetypeRole, PlacetypeRoles } from "@mailwoman/core/placetypes"
import { spawnProcessSync } from "@mailwoman/core/process"
import { CommandError, formatCommandError } from "@mailwoman/core/scripting/command"
import { childEnv } from "@mailwoman/core/scripting/utils"
import type { ScriptRoutedClassifier } from "@mailwoman/neural"
import { Box, Text } from "ink"
import { createElement as h, Fragment, useEffect, useState } from "react"
import type * as React from "react"

/**
 * Props shared by commands parsed through the native command specification.
 */
export interface ParsedCommandProps<Options, Args extends unknown[] = string[]> {
	options: Options
	args: Args
}

/**
 * React component whose arguments have already been parsed by the native command specification.
 */
export type ParsedCommandComponent<Options = Record<string, never>, Args extends unknown[] = string[]> = React.FC<
	ParsedCommandProps<Options, Args>
>

/**
 * Type-helper to infer the positional arguments of a command.
 */
/**
 * The lifecycle of a command's one-shot async task.
 */
export type CommandTaskState<T> =
	| { status: "running" }
	| { status: "done"; result: T }
	| { status: "error"; message: string }

/**
 * Run a command's one-shot async task and own the exit-code discipline: rejection renders the error state and exits 1;
 * resolution exits with `exitCode(result)` (default 0) — always AFTER the final frame committed. Replaces the
 * copy-pasted useEffect/useState/setImmediate dance in every command.
 */
/* oxlint-disable react-hooks/exhaustive-deps -- One-shot by design: the task/exitCode closures
	 capture their options at mount; tracking them (fresh closure per render) would re-run the task
	 every render. The empty/[state] deps are the point. */
export function useCommandTask<T>(task: () => Promise<T>, exitCode?: (result: T) => number): CommandTaskState<T> {
	const [state, setState] = useState<CommandTaskState<T>>({ status: "running" })

	useEffect(() => {
		void task().then(
			(result) => setState({ status: "done", result }),
			(error: unknown) => setState({ status: "error", message: formatCommandError(error) })
		)
	}, [])

	useEffect(() => {
		if (state.status === "running") return
		const code = state.status === "error" ? 1 : (exitCode?.(state.result) ?? 0)
		setImmediate(() => process.exit(code))
	}, [state])

	return state
}

/* oxlint-enable react-hooks/exhaustive-deps */

/**
 * The lifecycle of a {@linkcode lazyComponent}'s import. Deliberately the same three states as
 * {@linkcode CommandTaskState}: a deferred import is a one-shot async task that happens to resolve to a component.
 */
type LazyComponentState<P extends object> =
	| { status: "loading" }
	| { status: "loaded"; component: React.FC<P> }
	| { status: "error"; message: string }

/**
 * Wrap a heavy child component so its module loads on FIRST RENDER rather than at import.
 *
 * A component reached from JSX normally needs a top-level import, so one `import { DebugView } from "…"` in a branch
 * nobody took still widens the selected command's graph. `load` runs in an effect instead, and the wrapper renders
 * nothing until it resolves.
 *
 * Nothing on screen for one frame is the right fallback here and not a placeholder: Ink erases the previous frame when
 * it draws, so a "loading…" line taller than zero is a line the real first frame has to scrub. Commands that want a
 * spinner own one INSIDE the loaded component, where it can outlive the load.
 *
 * A REJECTED import is a command failure, and it takes {@linkcode useCommandTask}'s exact contract: the message renders
 * red and the process exits 1 from a `setImmediate`, after the frame has committed. That matters here more than for an
 * ordinary task — the usual reason a deferred import rejects is a missing optional peer dependency, and the alternative
 * is an unhandled rejection: node's default handler prints a react-reconciler stack over whatever the command had drawn
 * and takes the exit code with it.
 *
 * `React.lazy`/`Suspense` would express the happy path too, but its fallback lands in the same erase path and Ink has
 * no error boundary — a throw in render escapes `render()` itself, which is the reconciler stack this exists to avoid.
 */
export function lazyComponent<P extends object>(load: () => Promise<React.FC<P>>): React.FC<P> {
	return function LazyComponent(props: P) {
		const [state, setState] = useState<LazyComponentState<P>>({ status: "loading" })

		useEffect(() => {
			let live = true

			void load().then(
				(component) => {
					if (live) {
						setState({ status: "loaded", component })
					}
				},
				(error: unknown) => {
					if (live) {
						setState({
							status: "error",
							message: formatCommandError(error),
						})
					}
				}
			)

			return () => {
				live = false
			}
			// oxlint-disable-next-line react-hooks/exhaustive-deps -- `load` closes over a module specifier, which
			// cannot change for the life of the process; tracking it would re-import on every render.
		}, [])

		useEffect(() => {
			if (state.status !== "error") return

			setImmediate(() => process.exit(1))
		}, [state])

		if (state.status === "error") {
			return h(Text, { color: "red" }, state.message)
		}

		return state.status === "loaded" ? h(state.component, props) : null
	}
}

/**
 * Emit a command's final output as raw bytes, bypassing Ink's `<Text>` renderer.
 *
 * Ink word-wraps rendered text at the terminal width — and at 80 columns when stdout is piped — which corrupts
 * machine-readable output: a JSON string value longer than the width gets real newlines inserted mid-string, breaking
 * the document (observed 2026-08-07: `geocode --format json` on "Toledo Ohio" wrapped `intent_markers[].message` at 80
 * cols). Machine formats (json/jsonld/xml/tuple, `--json` flags) must never pass through `<Text>`.
 *
 * Returns `null` so the caller can `return writeRawStdout(result)` from the done branch. Safe to call from render:
 * {@linkcode useCommandTask} renders the done frame exactly once before its `process.exit`. Same pattern as
 * `commands/gazetteer/inspect/graph.tsx`.
 */
export function writeRawStdout(text: string | object): null {
	const normalized = typeof text === "string" ? text + "\n" : prettyJSON(text)

	process.stdout.write(normalized)

	return null
}

/**
 * One ✓/✗ line in a {@linkcode CheckList}.
 */
export interface Check {
	ok: boolean
	check: string
	detail?: string
}

/**
 * The ✓/✗ check-list + PASS/FAIL renderer (extracted from `gazetteer verify`). Pass `verdict` to append the summary
 * line.
 */
export function CheckList({ checks, verdict }: { checks: readonly Check[]; verdict?: boolean }): React.ReactElement {
	const lines = checks.map((c, i) =>
		h(
			Text,
			{ key: i, color: c.ok ? "green" : "red" },
			`${c.ok ? "✓" : "✗"} ${c.check}${c.detail ? `: ${c.detail}` : ""}`
		)
	)

	const summary =
		verdict === undefined
			? null
			: h(
					Text,
					{ color: verdict ? "green" : "red" },
					`${verdict ? "PASS" : "FAIL"} (${checks.filter((c) => c.ok).length}/${checks.length} checks)`
				)

	return h(Box, { flexDirection: "column" }, ...lines, summary)
}

/**
 * Parse a `--roles a,b,c` flag into validated {@link PlacetypeRole}s, or `undefined` when the flag is absent (which
 * every caller reads as "all roles").
 *
 * Rejects an unknown role with {@link CommandError} rather than silently filtering it — a typo in a role name would
 * otherwise produce an empty, entirely plausible-looking result.
 */
export function parseRoles(raw: string | undefined): PlacetypeRole[] | undefined {
	if (!raw) return undefined

	const valid = new Set<string>(PlacetypeRoles)

	const parsed = splitList(raw)

	for (const role of parsed) {
		if (!valid.has(role)) {
			throw new CommandError(`Unknown placetype role '${role}'. Valid roles: ${PlacetypeRoles.join(", ")}.`)
		}
	}

	return parsed as PlacetypeRole[]
}

/**
 * Write one progress line to stderr — the `report` callback every long-running command threads through its pipeline.
 * Stderr, so stdout stays machine-readable.
 */
export function reportToStderr(line: string): void {
	console.error(line)
}

/**
 * Props for {@linkcode CommandTaskResult}.
 */
export interface CommandTaskResultProps<T> {
	state: CommandTaskState<T>
	/**
	 * Rendered while the task runs. A string is wrapped in `<Text>`; omit it to render nothing.
	 */
	running?: React.ReactNode
	/**
	 * The done line's body, rendered after the `✓ `. Defaults to `String(result)` — the plain-string result shape.
	 */
	done?: (result: T) => React.ReactNode
}

/**
 * The standard ✓/✗ tail of a one-shot command: red `✗ message` on error, green `✓ …` on completion, and the `running`
 * node (or nothing) in between. A command with a custom done frame guards with `if (state.status !== "done") return
 * <CommandTaskResult state={state} … />` and renders its own done branch below.
 */
export function CommandTaskResult<T>({ state, running, done }: CommandTaskResultProps<T>): React.ReactElement | null {
	if (state.status === "running") {
		if (running === undefined || running === null) return null

		return typeof running === "string" ? h(Text, null, running) : h(Fragment, null, running)
	}

	if (state.status === "error") {
		return h(Text, { color: "red" }, `✗ ${state.message}`)
	}

	return h(Text, { color: "green" }, "✓ ", done ? done(state.result) : String(state.result))
}

/**
 * The `onPhase` reporter the gazetteer builds thread through their pipelines: ` [phase] detail` on stderr.
 */
export function phaseReporter(prefix = "  "): (phase: string, detail?: string) => void {
	return (phase, detail) => console.error(`${prefix}[${phase}]${detail ? ` ${detail}` : ""}`)
}

/**
 * Split a comma-separated flag into trimmed, non-empty entries. `undefined` and the empty string answer `[]`, and a
 * trailing comma contributes nothing rather than an empty entry.
 */
export function splitList(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
}

/**
 * {@linkcode splitList}, upper-cased — country and state-code flags.
 */
export function splitUpperList(raw: string | undefined): string[] {
	return splitList(raw).map((entry) => entry.toUpperCase())
}

/**
 * {@linkcode splitList} as numbers — resolution and size flags. Blank entries are dropped BEFORE conversion, so a
 * trailing comma is not a NaN.
 */
export function splitNumberList(raw: string | undefined): number[] {
	return splitList(raw).map(Number)
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "gu")

/**
 * Drop ANSI escape sequences from captured child-process output.
 */
export function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "")
}

/**
 * The shape every polygon-layer verification result shares — see `@mailwoman/flood`, `soil`, `coastal`, `zoning`.
 */
export interface LayerVerificationLike<Row extends { outcome: string; label: string }> {
	agreement: readonly Row[]
	agreed: number
	disagreed: number
	boundaryTolerance: number
	outside: ReadonlyArray<{ passed: boolean; label: string }>
	outsidePassed: number
}

/**
 * Options for {@linkcode formatLayerVerification}.
 */
export interface FormatLayerVerificationOptions<Row> {
	/**
	 * Who the artifact was checked against — "the live service", "Soil Data Access".
	 */
	serviceLabel: string
	/**
	 * The out-of-coverage line's scope — "outside England", "outside the built survey areas".
	 */
	outsideLabel: string
	/**
	 * One disagreement row as the stderr line naming its point.
	 */
	describeRow: (row: Row) => string
	/**
	 * Appended to the agreement summary — zoning's local-code mismatch count.
	 */
	extraSummary?: string
	/**
	 * The out-of-coverage line's all-clear tail. Default "none read a designation".
	 */
	outsideNoneLabel?: string
}

/**
 * The two verification summary lines every polygon-layer build prints, plus the per-row disagreement dump to stderr — a
 * disagreement count is not actionable on its own; the rows are, and the first thing anyone does with a non-zero count
 * is ask which points.
 */
export function formatLayerVerification<Row extends { outcome: string; label: string }>(
	verified: LayerVerificationLike<Row>,
	options: FormatLayerVerificationOptions<Row>
): string[] {
	for (const row of verified.agreement) {
		if (row.outcome === "disagree") {
			console.error(options.describeRow(row))
		}
	}

	const failedOutside = verified.outside.filter((row) => !row.passed).map((row) => row.label)

	return [
		`verify: ${verified.agreed}/${verified.agreement.length} agree with ${options.serviceLabel} · ` +
			`${verified.boundaryTolerance} within boundary tolerance · ${verified.disagreed} disagree` +
			(options.extraSummary ? ` · ${options.extraSummary}` : ""),
		`verify (${options.outsideLabel}): ${verified.outsidePassed}/${verified.outside.length} read unknown, ` +
			`${failedOutside.join(", ") || (options.outsideNoneLabel ?? "none read a designation")}`,
	]
}

/**
 * Run a child process with inherited stdio — the child's own output IS the progress log — and throw
 * {@linkcode CommandError} on a launch failure or nonzero exit. `echo` prints the invocation first; `cwd` runs the child
 * elsewhere.
 */
export function runProcessOrFail(
	cmd: string,
	args: readonly string[],
	options: { cwd?: string; echo?: boolean } = {}
): void {
	if (options.echo) {
		console.error(`  $ ${cmd} ${args.join(" ")}${options.cwd ? `  (in ${options.cwd})` : ""}`)
	}

	const result = spawnProcessSync(cmd, [...args], { stdio: "inherit", env: childEnv(), cwd: options.cwd })

	if (result.error) {
		throw new CommandError(`${cmd} ${args.join(" ")} → failed to launch: ${result.error.message}`, {
			cause: result.error,
		})
	}

	if (result.status !== 0) {
		throw new CommandError(`${cmd} ${args.join(" ")} → exit ${result.status}`)
	}
}

/**
 * Load the neural classifier, degrading to `undefined` with a precise warning (#1108) so a consumer can't attribute
 * silently-degraded output to the neural parser. Two failure modes are distinguished:
 *
 * - Weights ABSENT (package not installed / carries no binaries) → an install hint, no scary error text.
 * - Weights present but the encoder FAILED to load (corrupt / partial bundle, a bad explicit path) → the underlying error
 *   is surfaced, not swallowed.
 *
 * `onDegrade` receives the warning line; callers send it to stderr so piped stdout parsing is unaffected.
 */
export async function loadClassifierTolerant(
	locale: string,
	options: {
		modelPath?: string
		tokenizerPath?: string
		onDegrade: (message: string) => void
	}
): Promise<ScriptRoutedClassifier | undefined> {
	try {
		const { NeuralAddressClassifier } = await import("@mailwoman/neural")

		// Routed by script: a kanji or Hangul line runs on the character-path family, the primary stays the locale.
		return await NeuralAddressClassifier.loadRoutedFromWeights({
			locale,
			modelPath: options.modelPath,
			tokenizerPath: options.tokenizerPath,
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		// "Absent" = the weights package simply isn't installed (the resolver's not-found signal). Every OTHER
		// failure means the weights DID resolve but the encoder couldn't load them — a partial/metadata-only
		// bundle ("missing model files"), a bad explicit --model/--tokenizer path, or a corrupt artifact — so we
		// surface the underlying error verbatim rather than mislabel it "not installed" and swallow the cause.
		const absent = /Could not resolve/iu.test(message)
		const { weightsPackageName } = await import("@mailwoman/neural/weights")

		options.onDegrade(
			absent
				? `⚠ neural weights not found — running a degraded structural parse; install ${weightsPackageName(locale)} for full accuracy.`
				: `⚠ neural weights failed to load — running a degraded structural parse. Encoder error: ${message}`
		)

		return undefined
	}
}
