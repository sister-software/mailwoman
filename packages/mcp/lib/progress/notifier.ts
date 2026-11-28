// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * MCP progress notifications from the `ProcessProgress` steps the library and CLI already report.
 *
 * A tool reports each step through a {@linkcode ReportProgress} callback and never imports the SDK.
 * The server wraps the request context with {@linkcode progressNotifier}, which forwards each step as
 * a `notifications/progress` when the client sent a progress token, and returns null when it didn't.
 */

import type { ProcessProgress } from "@mailwoman/core/scripting/process"
import type { ProgressToken, ServerNotification } from "@modelcontextprotocol/sdk/types.js"

/**
 * Receives one progress step.
 *
 * `stage` names the phase, and `processed` of `total` counts its work when the phase can count it.
 */
export type ReportProgress = (step: ProcessProgress) => void

/**
 * A reporter that drops every step, for a call made without a progress token.
 */
export const ignoreProgress: ReportProgress = () => {}

/**
 * The part of the SDK's request handler context that progress needs.
 *
 * The SDK's request handler context satisfies it, so a handler passes its second argument straight through.
 */
export interface ProgressRequestContext {
	_meta?: { progressToken?: ProgressToken }
	sendNotification: (notification: ServerNotification) => Promise<void>
}

/**
 * Options for {@linkcode throttleProgress}.
 */
export interface ThrottleProgressOptions {
	/**
	 * The milliseconds a stage must run before another step of it passes.
	 * Default 250.
	 */
	intervalMs?: number
	/**
	 * The clock, in milliseconds.
	 * Default `performance.now()`.
	 */
	now?: () => number
}

/**
 * Pass a step on when its stage changes, when it completes the stage, or when `intervalMs` has passed.
 *
 * A loop over a few thousand rows reports every row, and the client sees a few updates a second.
 */
export function throttleProgress(report: ReportProgress, options: ThrottleProgressOptions = {}): ReportProgress {
	const intervalMs = options.intervalMs ?? 250
	const now = options.now ?? (() => performance.now())
	let lastStage: string | null = null
	let lastAt = -Infinity

	return (step) => {
		const at = now()
		const complete = step.total !== undefined && step.processed === step.total

		if (step.stage === lastStage && !complete && at - lastAt < intervalMs) return

		lastStage = step.stage
		lastAt = at
		report(step)
	}
}

/**
 * A reporter that sends each step as a `notifications/progress`, or null when the client sent no token.
 *
 * MCP requires `progress` to increase with every notification.
 * Each new stage therefore starts one past the last value sent, and a stage's counts add
 * to that start, so a bar that fills for one stage keeps rising through the next.
 *
 * A step that wouldn't raise the value is dropped.
 */
export function progressNotifier(
	context: ProgressRequestContext,
	options: ThrottleProgressOptions = {}
): ReportProgress | null {
	const progressToken = context._meta?.progressToken

	if (progressToken === undefined) return null

	let stage: string | null = null
	let start = 0
	let last = 0

	const send: ReportProgress = (step) => {
		if (step.stage !== stage) {
			stage = step.stage
			start = last + 1
		}

		const counted = step.processed ?? step.percent
		const value = start + (counted ?? 0)
		const total = step.total ?? (step.percent === undefined ? undefined : 100)

		if (value <= last) return

		last = value

		const message = step.total === undefined ? step.stage : `${step.stage} (${step.processed ?? 0} of ${step.total})`

		void context
			.sendNotification({
				method: "notifications/progress",
				params: { progressToken, progress: value, ...(total === undefined ? {} : { total: start + total }), message },
			})
			// A client that went away receives no more steps, and the call still runs to its result.
			.catch(() => {})
	}

	return throttleProgress(send, options)
}

/**
 * A reporter that puts a sub-task's label before each of its stages, as in `candidate: Comparing both arms`.
 *
 * For work that runs one measurement several times, so each run's stages read apart.
 */
export function prefixProgress(report: ReportProgress, prefix: string): ReportProgress {
	return (step) => report({ ...step, stage: `${prefix}: ${step.stage}` })
}

/**
 * A counter for a loop over `total` items.
 *
 * `step()` after each item adds one.
 * A loop that `continue`s can call `step(index)` at the top of each item and `step(total)`
 * after the loop instead, so no exit path skips the count.
 *
 * It reports the stage at zero when it's made, so a loop over a slow first item still shows it started.
 */
export function countProgress(report: ReportProgress, stage: string, total: number): (processed?: number) => void {
	let processed = 0

	report({ stage, processed, total })

	return (count) => {
		processed = count ?? processed + 1
		report({ stage, processed, total })
	}
}
