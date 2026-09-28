/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type Operation, type OperationContext, operationDefiner } from "@mailwoman/core/scripting"

/**
 * What a storage operation does to the world, declared rather than inferred.
 */
export const StorageEffect = {
	/**
	 * Reads block devices, mount state, or filesystem properties; makes no changes and needs no privilege.
	 */
	Read: "read",
	/**
	 * Writes host state outside the checkout — partition tables, filesystems, `/etc/fstab`,
	 * mounts — and requires root, so it is reachable only after the CLI wrapper has elevated.
	 */
	HostWrite: "host-write",
} as const

export type StorageEffect = (typeof StorageEffect)[keyof typeof StorageEffect]

/**
 * What every storage operation receives beside its input.
 */
export interface StorageContext extends OperationContext {
	/**
	 * Whether the current process holds root, supplied by the caller rather than read
	 * from `process` so a unit test can drive both paths.
	 */
	root: boolean
}

export type StorageOperation<In = unknown, Out = unknown> = Operation<StorageEffect, StorageContext, In, Out>

/**
 * Preserve an operation's input and output types while it sits in a heterogeneous registry array.
 */
export const defineOperation = operationDefiner<StorageEffect, StorageContext>()

/**
 * Throw unless the process holds root, so a missing elevation is a clear error
 * rather than a half-applied partition table.
 */
export function assertRoot(context: StorageContext, operationID: string): void {
	if (context.root) return

	throw new Error(`${operationID} needs root. Re-run under sudo, or install the NOPASSWD rule: yarn mwops:sudoers`)
}
