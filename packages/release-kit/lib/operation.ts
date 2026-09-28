/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The release family of operations: its effect union and its context, bound to the shared `Operation` shape from `@mailwoman/core/scripting`.
 */

import { type Operation, type OperationContext, operationDefiner } from "@mailwoman/core/scripting"

/**
 * What a release operation does to the world, declared rather than inferred;
 * `external-write` names the operations that publish (npm, Hugging Face, R2)
 * and are reachable only through the plan → execute interface.
 */
export const OperationEffect = {
	/**
	 * Reads the checkout, the data root, or a registry, and makes no change.
	 */
	Read: "read",
	/**
	 * Writes inside the checkout or the data root (a staging tree, a materialized binary, a generated surface).
	 */
	LocalWrite: "local-write",
	/**
	 * Writes to a system outside this machine.
	 *
	 * Irreversible, credentialed, and reachable only through the plan → execute interface.
	 */
	ExternalWrite: "external-write",
} as const

export type OperationEffect = (typeof OperationEffect)[keyof typeof OperationEffect]

/**
 * What every release operation receives beside its input.
 */
export interface ReleaseContext extends OperationContext {
	/**
	 * The repository root the operation works in.
	 */
	repoRoot: string
}

export type ReleaseOperation<In = unknown, Out = unknown> = Operation<OperationEffect, ReleaseContext, In, Out>

/**
 * Preserve an operation's input and output types while it sits in a heterogeneous registry array.
 */
export const defineOperation = operationDefiner<OperationEffect, ReleaseContext>()
