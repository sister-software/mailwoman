/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shape every operator capability takes. An operation has an id, a declared effect, typed input and output, and a
 *   `run`. It has no interface of its own: an adapter such as the private `mwops` CLI or an MCP server is a view over a
 *   registry of operations, and the adapter carries no logic of its own.
 *
 *   A family of operations (release, storage, shop) chooses its effect union and its context. The family binds both
 *   once through {@link operationDefiner}, so a call site infers its input and output types from the schemas it passes
 *   and receives the family's context in `run` without naming it.
 */

import type { ZodType } from "zod"

/**
 * What every operation receives beside its input, whatever its family.
 *
 * A family extends this with what its operations act on: a repository root, a privilege flag.
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
	 * Dotted, stable, and the name an adapter exposes: `release.preflight`, `storage.prepare`.
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
