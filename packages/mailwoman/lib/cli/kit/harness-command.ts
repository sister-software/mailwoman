/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one-shot harness command: run a task, show the ✓/✗ tail while it runs, print its own output.
 *
 *   Built with `createElement`, not JSX, for the reason `shared.ts` gives in its own header — the kit's index is
 *   imported under the dev `node →` condition, which strips `.ts` and cannot read `.tsx`.
 */

import { prettyJSON } from "@mailwoman/core/json"
import { Text } from "ink"
import { createElement as h } from "react"
import type * as React from "react"

import { type CommandComponent, CommandTaskResult, useCommandTask } from "#cli/kit/shared"
import type { CommandSpec, OptionsOf } from "#cli/native/spec"

/**
 * How a harness command differs from every other one: the task, and what it prints when the task is done.
 */
export interface HarnessCommandOptions<Spec extends CommandSpec, T> {
	/**
	 * The process exit code, read off the task's result. Absent means 0 on success; an error is 1 either way.
	 */
	exitCode?: (result: T) => number
	/**
	 * The value to print as JSON, or `undefined` to print nothing.
	 *
	 * The OPTIONS are passed so the gate is named at the call site rather than assumed here: a command that prints under
	 * `--json` writes `(result, options) => (options.json ? result.report : undefined)`, which keeps the flag that
	 * decides it in the file that declares it. A command whose task narrates on stdout omits this entirely — most of the
	 * commands under `commands/eval/` do, and rendering anything would duplicate their output.
	 */
	json?: (result: T, options: OptionsOf<Spec>) => unknown
}

/**
 * Build the command component for a one-shot harness task.
 *
 * Every command under `commands/eval/` had the same shape: call {@linkcode useCommandTask}, render
 * {@linkcode CommandTaskResult} while it runs, print the result as JSON under a flag, return `null` otherwise. What
 * differs between them is the task and the result type, so those are what a caller supplies.
 *
 * The control flow moves behind a name, which is the cost. It is paid back because the flow was identical in all of
 * them: a reader who wants it reads this file once instead of confirming twenty-odd copies agree.
 *
 * `_spec` is read only by the type checker, and it is the reason this takes three arguments: it anchors `Spec` so
 * `run`'s options are typed from the command's own declaration and `T` infers from what `run` returns. Naming both
 * explicitly instead — TypeScript has no partial inference — costs every call site the result type spelled out.
 */
export function harnessCommand<Spec extends CommandSpec, T>(
	_spec: Spec,
	run: (options: OptionsOf<Spec>) => Promise<T>,
	options: HarnessCommandOptions<Spec, T> = {}
): CommandComponent<Spec> {
	return function HarnessCommand({ options: parsed }): React.ReactElement | null {
		const state = useCommandTask(() => run(parsed), options.exitCode)

		if (state.status !== "done") return h(CommandTaskResult, { state })

		const payload = options.json?.(state.result, parsed)

		return payload === undefined ? null : h(Text, null, prettyJSON(payload))
	}
}
