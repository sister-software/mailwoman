// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The registry of `mwops host` operations: read whether a heavy job holds the host,
 * and wait for it to be idle.
 *
 * Both are read operations.
 * Neither takes nor releases the host lock.
 */

import { type Operation, OperationEffect, type OperationContext, operationDefiner } from "@mailwoman/core/scripting"
import { z } from "zod"

import { describeCIRun } from "#check-kit/ci-runs"
import {
	DEFAULT_MAX_WAIT_MINUTES,
	describeHolder,
	type HostStatus,
	type HostWait,
	readHostStatus,
	waitForIdleHost,
} from "#check-kit/host"

/**
 * The exit status of `mwops host wait-idle` when the bound expired with the host busy.
 */
const HOST_WAIT_EXPIRED_EXIT = 3

/**
 * The exit status of `mwops host wait-idle` when the bound expired while CI couldn't be read.
 */
const HOST_WAIT_UNREAD_EXIT = 4

const defineHostOperation = operationDefiner<OperationEffect, OperationContext>()

/**
 * The status as lines: the lock, then one line per CI run, or that CI is unread.
 */
function renderHostStatus(status: HostStatus): string[] {
	const lines = [
		`host: ${status.idle === true ? "idle" : status.idle === false ? "busy" : "unknown, because CI is unread"}`,
	]

	const { lock, ci } = status

	if (lock.state === "free") {
		lines.push("lock: free")
	} else if (lock.state === "unreadable") {
		lines.push(`lock: held, and its owner record at ${lock.path} is unreadable`)
	} else {
		lines.push(
			`lock: held by ${describeHolder(lock.holder)}${lock.stale ? `; stale, because ${lock.stale}, so the next heavy check releases it` : ""}`
		)
	}

	if (!ci.read) {
		lines.push(`ci: unread (${ci.error})`)
	} else {
		lines.push(`ci: ${ci.runs.length} queued or in-progress run(s)`)

		for (const run of ci.runs) {
			lines.push(`  ${describeCIRun(run)}`)
		}

		for (const run of ci.excluded) {
			lines.push(`  not counted, because ${run.reason}: ${describeCIRun(run)}`)
		}
	}

	return lines
}

/**
 * `host.status`: the host lock holder and the CI runs, read once.
 */
const hostStatusOperation = defineHostOperation({
	id: "host.status",
	description: "Whether a heavy mwops check holds the host lock, and the queued or in-progress CI runs.",
	effect: OperationEffect.Read,
	options: {},
	inputSchema: z.object({}).strict(),
	outputSchema: z.custom<HostStatus>(),
	run: () => readHostStatus(),
	formatOutput: (output) => renderHostStatus(output).join("\n"),
})

/**
 * `host.wait-idle`: poll the host until it is idle or `--max-minutes` passes, and report which happened.
 */
const hostWaitIdleOperation = defineHostOperation({
	id: "host.wait-idle",
	description: "Wait until no heavy check holds the host lock and no CI run is active, for at most --max-minutes.",
	effect: OperationEffect.Read,
	options: { "max-minutes": { type: "string" } },
	inputSchema: z.object({ "max-minutes": z.coerce.number().positive().default(DEFAULT_MAX_WAIT_MINUTES) }).strict(),
	outputSchema: z.custom<HostWait>(),
	run: (input, context) => {
		context.log(`waiting at most ${input["max-minutes"]} minute(s) for an idle host`)

		return waitForIdleHost(input["max-minutes"] * 60_000)
	},
	formatOutput: (output) =>
		[
			output.outcome === "idle"
				? `idle after ${Math.round(output.waitedMs / 1000)} s`
				: `the ${Math.round(output.maxWaitMs / 60_000)}-minute bound expired; ${output.outcome === "unread" ? "CI was unread" : "the host was still busy"}`,
			...renderHostStatus(output.status),
		].join("\n"),
})

/**
 * Every host operation, in the order `mwops` lists them.
 */
export const hostOperations = [hostStatusOperation, hostWaitIdleOperation] as ReadonlyArray<
	Operation<OperationEffect, OperationContext, unknown, unknown>
>

/**
 * The exit status a host operation's output produces: `wait-idle` exits non-zero when its bound expired.
 */
export function hostExitCode(output: unknown): number {
	const outcome = (output as Partial<HostWait>).outcome

	if (outcome === "expired") return HOST_WAIT_EXPIRED_EXIT

	if (outcome === "unread") return HOST_WAIT_UNREAD_EXIT

	return 0
}
