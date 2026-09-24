/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared Ink helpers and types for CLI commands. Kept outside `commands/` so the router does not treat it as a
 *   command, and written without JSX for Node type stripping.
 */

import { formatAsCountryISO2, type CountryISO2 } from "@mailwoman/codex/country"
import { formatAsUSStateAbbreviation, type USStateAbbreviation } from "@mailwoman/codex/us"
// Import specific core modules to keep each command's dependency graph small.
import { prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import { type PlacetypeRole, PlacetypeRoles } from "@mailwoman/core/placetypes"
import { spawnProcessSync } from "@mailwoman/core/process"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { CommandError, formatCommandError } from "@mailwoman/core/scripting/command"
import { childEnv } from "@mailwoman/core/scripting/utils"
import type { NeuralAddressClassifier, ScriptRoutedClassifier } from "@mailwoman/neural"
import { Box, Text } from "ink"
import type { PathBuilderLike } from "path-ts"
import { createElement as h, Fragment, useEffect, useState } from "react"
import type * as React from "react"

import type { CommandSpec, OptionsOf } from "#cli/native/spec"

/**
 * Props for commands parsed from a native specification.
 */
export interface ParsedCommandProps<Options, Args extends unknown[] = string[]> {
	options: Options
	args: Args
}

/**
 * Component receiving parsed command arguments.
 */
export type ParsedCommandComponent<Options = Record<string, never>, Args extends unknown[] = string[]> = React.FC<
	ParsedCommandProps<Options, Args>
>

/**
 * Command component whose option type is inferred from its `spec`.
 */
export type CommandComponent<Spec extends CommandSpec, Args extends unknown[] = string[]> = ParsedCommandComponent<
	OptionsOf<Spec>,
	Args
>

/**
 * The lifecycle of a command's one-shot async task.
 */
export type CommandTaskState<T> =
	| { status: "running" }
	| { status: "done"; result: T }
	| { status: "error"; message: string }

/**
 * Run a one-shot task, render its state, then exit with the result code or 1 on failure.
 */
/* oxlint-disable react-hooks/exhaustive-deps -- Task closures are captured once; rerunning on each render is incorrect. */
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
 * State of a deferred component import.
 */
type LazyComponentState<P extends object> =
	| { status: "loading" }
	| { status: "loaded"; component: React.FC<P> }
	| { status: "error"; message: string }

/**
 * Defer loading a heavy child until first render.
 *
 * Render nothing while loading and show import failures before exiting.
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
			// oxlint-disable-next-line react-hooks/exhaustive-deps -- Module specifier is fixed for the process lifetime.
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
 * Write machine-readable output directly to stdout to avoid Ink wrapping.
 * Return `null` for use in a render branch.
 */
export function writeRawStdout(text: string | object): null {
	const normalized = typeof text === "string" ? text + "\n" : prettyJSON(text)

	process.stdout.write(normalized)

	return null
}

/**
 * One check-list entry.
 */
export interface Check {
	ok: boolean
	check: string
	detail?: string
}

/**
 * Render check results and an optional pass/fail summary.
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
 * Parse and validate comma-separated placetype roles; return `undefined` when absent.
 */
export function parseRoles(raw: string | undefined): PlacetypeRole[] | undefined {
	if (!raw) return undefined

	const valid = new Set<string>(PlacetypeRoles)

	const parsed = extractDelimited(raw)

	for (const role of parsed) {
		if (!valid.has(role)) {
			throw new CommandError(`Unknown placetype role '${role}'. Valid roles: ${PlacetypeRoles.join(", ")}.`)
		}
	}

	return parsed as PlacetypeRole[]
}

/**
 * Write progress to stderr so stdout remains machine-readable.
 */
export function reportToStderr(line: string): void {
	console.error(line)
}

/**
 * Props for the standard command-task result renderer.
 */
export interface CommandTaskResultProps<T> {
	state: CommandTaskState<T>
	/**
	 * Content shown while the task runs; omit to render nothing.
	 */
	running?: React.ReactNode
	/**
	 * Content shown after success; defaults to `String(result)`.
	 */
	done?: (result: T) => React.ReactNode
}

/**
 * Render running, error, and success states for a one-shot command.
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
 * Create a stderr phase reporter for build pipelines.
 */
export function phaseReporter(prefix = "  "): (phase: string, detail?: string) => void {
	return (phase, detail) => console.error(`${prefix}[${phase}]${detail ? ` ${detail}` : ""}`)
}

/**
 * Parse comma-separated ISO 3166-1 alpha-2 country codes.
 */
export function splitCountryCodes(raw: string | undefined): CountryISO2[] {
	return extractDelimited(raw).map(formatAsCountryISO2)
}

/**
 * Parse comma-separated USPS state and territory abbreviations.
 */
export function splitUSStateCodes(raw: string | undefined): USStateAbbreviation[] {
	return extractDelimited(raw).flatMap((value) => {
		const code = formatAsUSStateAbbreviation(value)

		return code ? [code] : []
	})
}

/**
 * Parse a non-negative integer count, or return `fallback` when absent.
 * Reject invalid values and preserve zero.
 */
export function countOption(raw: string | undefined, fallback: number): number {
	if (raw == null) return fallback

	// Treat blank input as invalid rather than zero.
	const parsed = raw.trim() === "" ? Number.NaN : Number(raw)

	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new CommandError(`expected a non-negative integer, got ${stringifyJSON(raw)}`)
	}

	return parsed
}

/**
 * Parse comma-separated numeric values, ignoring blank entries.
 */
export function splitNumberList(raw: string | undefined): number[] {
	return extractDelimited(raw).map(Number)
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "gu")

/**
 * Remove ANSI escape sequences from child-process output.
 */
export function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "")
}

/**
 * Shared result shape for polygon-layer verification.
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
	 * Service used for comparison.
	 */
	serviceLabel: string
	/**
	 * Scope described by the out-of-coverage line.
	 */
	outsideLabel: string
	/**
	 * Format one disagreement row for stderr.
	 */
	describeRow: (row: Row) => string
	/**
	 * Optional detail appended to the agreement summary.
	 */
	extraSummary?: string
	/**
	 * All-clear text for the out-of-coverage summary.
	 */
	outsideNoneLabel?: string
}

/**
 * Format verification summaries and print each disagreement to stderr.
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
 * Run a child with inherited stdio and throw on launch failure or nonzero exit.
 */
export function runProcessOrFail(
	cmd: string,
	args: readonly string[],
	options: { cwd?: PathBuilderLike; echo?: boolean } = {}
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
 * Load the neural classifier.
 *
 * Report missing weights as a warning, but propagate errors from a present invalid bundle.
 * Callers should send `onDegrade` messages to stderr.
 */
export async function loadClassifierTolerant(
	locale: string,
	options: {
		modelPath?: string
		tokenizerPath?: string
		onDegrade: (message: string) => void
	}
): Promise<ScriptRoutedClassifier<NeuralAddressClassifier> | undefined> {
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
		// "Absent" = the weights package simply isn't installed (the resolver's not-found signal).
		// Every other failure means the weights did resolve but the encoder couldn't load them —
		// a partial/metadata-only bundle ("missing model files"), a bad explicit --model/--tokenizer
		// path, or a corrupt artifact — so we surface the underlying error verbatim
		// rather than mislabel it "not installed" and swallow the cause.
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
