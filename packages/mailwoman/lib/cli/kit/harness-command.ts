/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one-shot harness command: run a task, show the ✓/✗ tail while it runs, print its own output.
 *
 *   The command uses `createElement` because the kit's index loads under the dev `node →` condition.
 *   That condition strips `.ts` and cannot read `.tsx`.
 */

import { prettyJSON } from "@mailwoman/core/json"
import { Text } from "ink"
import { createElement as h } from "react"
import type * as React from "react"

import { type CommandComponent, CommandTaskResult, useCommandTask } from "#cli/kit/shared"
import type { CommandSpec, OptionsOf } from "#cli/native/spec"

/**
 * The task a harness command runs and its output when the task finishes.
 */
export interface HarnessCommandOptions<Spec extends CommandSpec, T> {
	/**
	 * The process exit code, read off the task's result.
	 *
	 * An absent callback result means 0 on success.
	 * Errors produce 1 either way.
	 */
	exitCode?: (result: T) => number
	/**
	 * The value to print as JSON, or `undefined` to print none.
	 *
	 * The options are passed so the call site states the condition rather than relying on an assumption here.
	 */
	json?: (result: T, options: OptionsOf<Spec>) => unknown
}

/**
 * `_spec` is read only by the type checker: it anchors `Spec` so `run`'s options are
 * typed from the command's own declaration and `T` infers from what `run` returns,
 * since TypeScript has no partial inference.
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
