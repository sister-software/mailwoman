/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The storage family of operations, bound to the shared `Operation` shape from `@mailwoman/core/scripting`. Storage
 *   is the one capability family that writes outside both the checkout and the data root: a partition table, a
 *   filesystem, an `/etc/fstab` line, a mount. `HostWrite` names that, and it is the flag the CLI wrapper reads to
 *   decide whether to acquire root before dispatching.
 *
 *   Operations never elevate themselves. An operation that needs root asserts it and fails if it does not have it,
 *   which keeps this package free of `process` and testable without a privileged sandbox.
 */

import { type Operation, type OperationContext, operationDefiner } from "@mailwoman/core/scripting"

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
	 * Writes host state outside the checkout: partition tables, filesystems, `/etc/fstab`, mounts.
	 *
	 * Requires root, and is therefore reachable only after the CLI wrapper has elevated.
	 */
	HostWrite: "host-write",
} as const

export type StorageEffect = (typeof StorageEffect)[keyof typeof StorageEffect]

/**
 * What every storage operation receives beside its input.
 */
export interface StorageContext extends OperationContext {
	/**
	 * Whether the current process holds root.
	 *
	 * Supplied by the caller rather than read from `process`, so a unit test can drive both paths.
	 */
	root: boolean
}

export type StorageOperation<In = unknown, Out = unknown> = Operation<StorageEffect, StorageContext, In, Out>

/**
 * Preserve an operation's input and output types while it sits in a heterogeneous registry array.
 */
export const defineOperation = operationDefiner<StorageEffect, StorageContext>()

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
