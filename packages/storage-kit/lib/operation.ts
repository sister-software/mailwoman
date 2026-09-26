/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shape every storage operation takes. Storage is the one capability family that writes outside both the
 *   checkout and the data root: a partition table, a filesystem, an `/etc/fstab` line, a mount. `HostWrite` names
 *   that, and it is the flag the CLI wrapper reads to decide whether to acquire root before dispatching.
 *
 *   Operations never elevate themselves. An operation that needs root asserts it and fails if it does not have it,
 *   which keeps this package free of `process` and testable without a privileged sandbox.
 */

import type { ZodType } from "zod"

/**
 * What a storage operation does to the world, declared rather than inferred.
 */
export const StorageEffect = {
	/**
	 * Reads block devices, mount state, or filesystem properties.
	 * Makes no changes, needs no privilege.
	 */
	Read: "read",
	/**
	 * Writes host state outside the checkout — partition tables, filesystems, `/etc/fstab`, mounts.
	 *
	 * Requires root, and is therefore reachable only after the CLI wrapper has elevated.
	 */
	HostWrite: "host-write",
} as const

export type StorageEffect = (typeof StorageEffect)[keyof typeof StorageEffect]

/**
 * What every storage operation receives beside its input.
 */
export interface StorageContext {
	/**
	 * When true, an operation with a write effect describes what it would do and makes no writes.
	 */
	dryRun: boolean
	/**
	 * Whether the current process holds root.
	 *
	 * Supplied by the caller rather than read from `process`, so a unit test can drive both paths.
	 */
	root: boolean
	/**
	 * Where an operation's progress lines go.
	 */
	log: (line: string) => void
}

export interface StorageOperation<In = unknown, Out = unknown> {
	/**
	 * Dotted, stable, and the name an adapter exposes: `storage.prepare`, `storage.verify`.
	 */
	id: string
	description: string
	effect: StorageEffect
	inputSchema: ZodType<In>
	outputSchema: ZodType<Out>
	run(input: In, context: StorageContext): Promise<Out>
	/**
	 * Optional one-line rendering for an interactive CLI.
	 */
	formatOutput?: (output: Out) => string
}

/**
 * Preserve an operation's input and output types while it sits in a heterogeneous registry array.
 */
export function defineOperation<In, Out>(operation: StorageOperation<In, Out>): StorageOperation<In, Out> {
	return operation
}

/**
 * Throw unless the process holds root.
 *
 * Every `HostWrite` operation calls this first so that a missing elevation is a
 * clear error rather than a half-applied partition table.
 */
export function assertRoot(context: StorageContext, operationID: string): void {
	if (context.root) return

	throw new Error(`${operationID} needs root. Re-run under sudo, or install the NOPASSWD rule: yarn mwops:sudoers`)
}
