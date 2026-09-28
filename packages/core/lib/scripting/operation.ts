/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This module defines the shape of each operator capability.
 *   An operation has an ID and a declared effect.
 *   It accepts typed input and returns typed output.
 *   Its `run` function performs the operation.
 *   An adapter such as the private `mwops` CLI or an MCP server views a registry of operations.
 *   The adapter carries no separate logic.
 *
 *   An operation family chooses its effect union and context.
 *   Release operations are one example. Storage and shop are two others.
 *   The family binds its effect and context through {@link operationDefiner}.
 *   A call site infers input and output types from its schemas.
 *   The `run` function receives the family's context without the caller naming it.
 */

import type { ZodType } from "zod"

/**
 * What every operation receives beside its input, whatever its family.
 *
 * A family extends this with the values its operations use, such as a repository root or privilege flag.
 */
export interface OperationContext {
	/**
	 * When true, an operation with a write effect describes what it would do and writes no change.
	 */
	dryRun: boolean
	/**
	 * Where an operation's progress lines go.
	 *
	 * An adapter that owns stdout (a `--json` command) passes a silent one.
	 */
	log: (line: string) => void
}

export interface Operation<
	TEffect extends string = string,
	TContext extends OperationContext = OperationContext,
	In = unknown,
	Out = unknown,
> {
	/**
	 * A stable dotted name that an adapter exposes, such as `release.preflight` or `storage.prepare`.
	 */
	id: string
	description: string
	/**
	 * What the operation does to the world, declared rather than inferred.
	 */
	effect: TEffect
	inputSchema: ZodType<In>
	outputSchema: ZodType<Out>
	run(input: In, context: TContext): Promise<Out>
	/**
	 * Optional one-line rendering for an interactive CLI.
	 *
	 * Structured adapters continue to use the operation's output.
	 */
	formatOutput?: (output: Out) => string
}

/**
 * A family's `defineOperation`.
 *
 * It preserves an operation's input and output types while it sits in a heterogeneous registry array.
 */
export type OperationDefiner<TEffect extends string, TContext extends OperationContext> = <In, Out>(
	operation: Operation<TEffect, TContext, In, Out>
) => Operation<TEffect, TContext, In, Out>

/**
 * Bind a family's effect union and context once.
 *
 * TypeScript infers every type argument of a call or none of them.
 * A definer that took the family's types beside the operation's would make each
 * call site spell out its input and output types.
 *
 * Binding the family first leaves only the two the schemas already carry.
 */
export function operationDefiner<TEffect extends string, TContext extends OperationContext>(): OperationDefiner<
	TEffect,
	TContext
> {
	return (operation) => operation
}

/**
 * Look an operation up by its dotted id (`storage.prepare`) or its bare name within a family (`prepare`).
 */
export function findOperation<TOperation extends Operation>(
	registry: ReadonlyArray<TOperation>,
	family: string,
	name: string
): TOperation | undefined {
	const id = name.includes(".") ? name : `${family}.${name}`

	return registry.find((operation) => operation.id === id)
}
