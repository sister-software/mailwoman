/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The registry of storage operations — the only executable entry point of this package. Knip treats it as
 *   such. An operation that is not listed here is dead code. The `mwops` adapter iterates this array and
 *   never import an operation module directly.
 */

import { findOperation } from "@mailwoman/core/scripting"

import type { StorageOperation } from "#storage-kit/operation"
import { installSudoersOperation, installUdevRuleOperation } from "#storage-kit/operations/install-rules"
import { planOperation } from "#storage-kit/operations/plan"
import { prepareOperation } from "#storage-kit/operations/prepare"
import { statusOperation } from "#storage-kit/operations/status"
import { verifyOperation } from "#storage-kit/operations/verify"

/**
 * Every storage operation, in the order an adapter lists them: the read-only look first,
 * then the one host write, then the checks that follow it.
 */
export const storageOperations: ReadonlyArray<StorageOperation<unknown, unknown>> = [
	planOperation,
	prepareOperation,
	verifyOperation,
	statusOperation,
	installUdevRuleOperation,
	installSudoersOperation,
] as ReadonlyArray<StorageOperation<unknown, unknown>>

/**
 * Look a storage operation up by its bare name (`prepare`) or its dotted id (`storage.prepare`).
 */
export function findStorageOperation(name: string): StorageOperation<unknown, unknown> | undefined {
	return findOperation(storageOperations, "storage", name)
}
