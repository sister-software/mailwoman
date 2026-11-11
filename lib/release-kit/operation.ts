/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The release family of operations: its effect union and its context, bound to the shared `Operation` shape from `@mailwoman/core/scripting`.
 */

import {
	type Operation,
	type OperationContext,
	type OperationEffect,
	operationDefiner,
} from "@mailwoman/core/scripting"

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
