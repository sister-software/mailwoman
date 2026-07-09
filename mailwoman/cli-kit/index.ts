/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The command toolkit for `mailwoman/commands/*` — Pastel/Ink helper types, the one-shot
 *   {@linkcode useCommandTask} runner, and the {@linkcode CheckList} renderer. Lives OUTSIDE
 *   `commands/` (Pastel treats every file there as a command) and OUTSIDE `sdk/` (`sdk/` submodules
 *   mean data acquisition). Built with `createElement`, not JSX, so the module stays plain `.ts` —
 *   importable under node's type stripping (the dev `node →` exports condition).
 */

import { Box, Text } from "ink"
import { createElement as h, useEffect, useState } from "react"
import type * as React from "react"
import type * as zod from "zod"

/**
 * Type-helper to infer the positional arguments of a command.
 */
export type PositionalArguments<T extends zod.ZodTypeAny> = {
	args: zod.infer<T>
}

/**
 * React component for a command with positional arguments.
 */
export type PositionalCommandComponent<T extends zod.ZodTypeAny> = React.FC<PositionalArguments<T>>

/**
 * Type-helper to infer the options of a command.
 */
export type CommandProps<
	OptionProps extends zod.ZodObject,
	PositionalProps extends zod.ZodTypeAny | unknown = unknown,
> = {
	options: zod.infer<OptionProps>
	args: PositionalProps extends zod.ZodTypeAny ? zod.infer<PositionalProps> : unknown[]
}

/**
 * React component for a command with options.
 */
export type CommandComponent<
	OptionProps extends zod.ZodObject,
	PositionalProps extends zod.ZodTypeAny | unknown = unknown,
> = React.FC<CommandProps<OptionProps, PositionalProps>>

/** The lifecycle of a command's one-shot async task. */
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
			(error: unknown) =>
				setState({ status: "error", message: error instanceof Error ? (error.stack ?? error.message) : String(error) })
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

/** One ✓/✗ line in a {@linkcode CheckList}. */
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
