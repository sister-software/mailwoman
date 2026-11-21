// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The registry of `mwops pr` operations: read one pull request's checks, and wait until they conclude.
 *
 * Both are read operations.
 * Each exits with the status {@link PullRequestExit} names.
 */

import { type Operation, OperationEffect, type OperationContext, operationDefiner } from "@mailwoman/core/scripting"
import { z } from "zod"

import {
	DEFAULT_PULL_REQUEST_POLL_SECONDS,
	DEFAULT_PULL_REQUEST_WAIT_MINUTES,
	PullRequestExit,
	type PullRequestStatus,
	type PullRequestWait,
	readPullRequestStatus,
	renderPullRequestStatus,
	waitForPullRequestConclusion,
} from "#check-kit/pull-request/status"

const definePullRequestOperation = operationDefiner<OperationEffect, OperationContext>()

const NUMBER_OPTION = { "pull-request": { type: "string" } } as const

const NUMBER_SCHEMA = z.coerce.number().int().positive()

/**
 * `pr.status`: the pull request's checks, read once.
 */
const pullRequestStatusOperation = definePullRequestOperation({
	id: "pr.status",
	description: "One pull request's head commit, mergeable state and checks, with the failing tests of each failed job.",
	effect: OperationEffect.Read,
	options: NUMBER_OPTION,
	inputSchema: z.object({ "pull-request": NUMBER_SCHEMA }).strict(),
	outputSchema: z.custom<PullRequestStatus>(),
	run: (input) => readPullRequestStatus(input["pull-request"]),
	formatOutput: (output) => renderPullRequestStatus(output).join("\n"),
})

/**
 * `pr.wait`: read the checks until one fails, zero are pending, or `--max-minutes` passes.
 */
const pullRequestWaitOperation = definePullRequestOperation({
	id: "pr.wait",
	description: "Wait until a check on one pull request fails or zero are pending, for at most --max-minutes.",
	effect: OperationEffect.Read,
	options: { ...NUMBER_OPTION, "max-minutes": { type: "string" }, "poll-seconds": { type: "string" } },
	inputSchema: z
		.object({
			"pull-request": NUMBER_SCHEMA,
			"max-minutes": z.coerce.number().positive().default(DEFAULT_PULL_REQUEST_WAIT_MINUTES),
			"poll-seconds": z.coerce.number().positive().default(DEFAULT_PULL_REQUEST_POLL_SECONDS),
		})
		.strict(),
	outputSchema: z.custom<PullRequestWait>(),
	run: (input, context) => {
		context.log(
			`waiting at most ${input["max-minutes"]} minute(s) for the checks on #${input["pull-request"]}, reading every ${input["poll-seconds"]} s`
		)

		return waitForPullRequestConclusion(input["pull-request"], {
			maxWaitMs: input["max-minutes"] * 60_000,
			pollMs: input["poll-seconds"] * 1000,
		})
	},
	formatOutput: (output) => renderPullRequestStatus(output, output).join("\n"),
})

/**
 * Every pull request operation, in the order `mwops` lists them.
 */
export const pullRequestOperations = [pullRequestStatusOperation, pullRequestWaitOperation] as ReadonlyArray<
	Operation<OperationEffect, OperationContext, unknown, unknown>
>

/**
 * The exit status a pull request operation's output produces.
 */
export function pullRequestExitCode(output: unknown): number {
	const exitCode = (output as Partial<PullRequestStatus>).exitCode

	return typeof exitCode === "number" ? exitCode : PullRequestExit.Unread
}

/**
 * Rewrite `status <number> …` as `status --pull-request <number> …`, so the number
 * may be given as the operation's positional argument.
 */
export function pullRequestOperationArgs(args: readonly string[]): string[] {
	const [id, number, ...rest] = args

	if (id == null || number == null || number.startsWith("-")) return [...args]

	return [id, "--pull-request", number, ...rest]
}
