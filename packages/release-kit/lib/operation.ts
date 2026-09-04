/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shape every release operation takes. An operation is a capability: it has an id, a declared effect, typed
 *   input and output, and a `run`. It has no interface of its own — the private `mwops` CLI and the release MCP server
 *   are views over the registry in `registry.ts`, and neither carries release logic.
 */

import type { ZodType } from "zod"

/**
 * What an operation does to the world, declared rather than inferred. `external-write` names the operations that
 * publish (npm, Hugging Face, R2) and are therefore reachable only through the plan → execute contract.
 */
export const OperationEffect = {
	/**
	 * Reads the checkout, the data root, or a registry; changes nothing.
	 */
	Read: "read",
	/**
	 * Writes inside the checkout or the data root (a staging tree, a materialized binary, a generated surface).
	 */
	LocalWrite: "local-write",
	/**
	 * Writes to a system outside this machine. Irreversible, credentialed, and reachable only through the plan → execute
	 * contract.
	 */
	ExternalWrite: "external-write",
} as const

export type OperationEffect = (typeof OperationEffect)[keyof typeof OperationEffect]

/**
 * What every operation receives beside its input.
 */
export interface ReleaseContext {
	/**
	 * The repository root the operation works in.
	 */
	repoRoot: string
	/**
	 * When true, an operation with a write effect describes what it would do and writes nothing.
	 */
	dryRun: boolean
	/**
	 * Where an operation's progress lines go. An adapter that owns stdout (a `--json` command) passes a silent one.
	 */
	log: (line: string) => void
}

export interface ReleaseOperation<In = unknown, Out = unknown> {
	/**
	 * Dotted, stable, and the name an adapter exposes: `release.preflight`, `release.publish`.
	 */
	id: string
	description: string
	effect: OperationEffect
	inputSchema: ZodType<In>
	outputSchema: ZodType<Out>
	run(input: In, context: ReleaseContext): Promise<Out>
}

/**
 * Preserve an operation's input and output types while it sits in a heterogeneous registry array.
 */
export function defineOperation<In, Out>(operation: ReleaseOperation<In, Out>): ReleaseOperation<In, Out> {
	return operation
}
