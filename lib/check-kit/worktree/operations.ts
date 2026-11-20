// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The registry of `mwops worktree` operations, run from a checkout with its own install
 * and aimed at another working tree with `--path`.
 *
 * `status` reads what the tree lacks.
 * `prepare` runs the missing steps in that tree, under one host lock.
 */

import { type Operation, OperationEffect, type OperationContext, operationDefiner } from "@mailwoman/core/scripting"
import { resolvePath } from "path-ts"
import { z } from "zod"

import { DEFAULT_MAX_WAIT_MINUTES } from "#check-kit/host"
import { type PrepareResult, renderPrepareResult, runPrepare } from "#check-kit/worktree/prepare"
import { readWorktreeStatus, renderWorktreeStatus, type WorktreeStatus } from "#check-kit/worktree/status"

/**
 * What a worktree operation receives: the checkout `mwops` runs from.
 */
export interface WorktreeContext extends OperationContext {
	repoRoot: string
}

const defineWorktreeOperation = operationDefiner<OperationEffect, WorktreeContext>()

const pathInput = z.string().min(1, "--path names the working tree to read")

/**
 * `worktree.status`: each prerequisite of the tree that contains `--path`, and whether it is ready.
 */
const worktreeStatusOperation = defineWorktreeOperation({
	id: "worktree.status",
	description:
		"Report what the working tree at --path lacks: node_modules, a current out/, the weights files, its position against origin/main, and its .env.",
	effect: OperationEffect.Read,
	options: { path: { type: "string" } },
	inputSchema: z.object({ path: pathInput }).strict(),
	outputSchema: z.custom<WorktreeStatus>(),
	run: (input, context) =>
		readWorktreeStatus(resolvePath(context.repoRoot, input.path), { callingCheckout: context.repoRoot }),
	formatOutput: (output) => renderWorktreeStatus(output).join("\n"),
})

/**
 * `worktree.prepare`: run `yarn install`, `yarn compile` and `yarn mwops release copy-weights` in
 * the tree at `--path`, each only when its prerequisite is missing, then read the status again.
 */
const worktreePrepareOperation = defineWorktreeOperation({
	id: "worktree.prepare",
	description:
		"Run the missing setup steps in the working tree at --path (yarn install, yarn compile, yarn mwops release copy-weights) under one host lock, then read its status again.",
	effect: OperationEffect.LocalWrite,
	options: { path: { type: "string" }, "max-wait-minutes": { type: "string" }, "log-dir": { type: "string" } },
	inputSchema: z
		.object({
			path: pathInput,
			"max-wait-minutes": z.coerce.number().nonnegative().default(DEFAULT_MAX_WAIT_MINUTES),
			"log-dir": z.string().min(1).optional(),
		})
		.strict(),
	outputSchema: z.custom<PrepareResult>(),
	run: (input, context) =>
		runPrepare(resolvePath(context.repoRoot, input.path), {
			callingCheckout: context.repoRoot,
			dryRun: context.dryRun,
			maxWaitMs: input["max-wait-minutes"] * 60_000,
			noWait: false,
			logDirectory: input["log-dir"] ? resolvePath(context.repoRoot, input["log-dir"]) : undefined,
			host: { log: context.log },
		}),
	formatOutput: (output) =>
		[...renderPrepareResult(output), ...(output.after ? renderWorktreeStatus(output.after) : [])].join("\n"),
})

/**
 * Every worktree operation, in the order `mwops` lists them.
 */
export const worktreeOperations = [worktreeStatusOperation, worktreePrepareOperation] as ReadonlyArray<
	Operation<OperationEffect, WorktreeContext, unknown, unknown>
>

/**
 * The exit status a worktree operation's output produces.
 *
 * `prepare` exits with its own status: 0 only when the status after the steps is ready.
 * `status` exits 0 when the tree is ready and 1 when it isn't.
 */
export function worktreeExitCode(output: unknown): number {
	const prepare = output as Partial<PrepareResult>

	if (typeof prepare.exitCode === "number") return prepare.exitCode

	return (output as Partial<WorktreeStatus>).ready === true ? 0 : 1
}
