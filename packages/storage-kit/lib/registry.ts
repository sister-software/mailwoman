/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The registry of storage operations — the only executable entry point of this package, and the file knip treats as
 *   such. An operation that is not listed here is dead code. Adapters (`@mailwoman/ops-cli`) iterate this array and
 *   never import an operation module directly.
 */

import type { StorageOperation } from "#operation"
import { installSudoersOperation, installUdevRuleOperation } from "#operations/install-rules"
import { planOperation } from "#operations/plan"
import { prepareOperation } from "#operations/prepare"
import { statusOperation } from "#operations/status"
import { verifyOperation } from "#operations/verify"

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
	return storageOperations.find((operation) => operation.id === name || operation.id === `storage.${name}`)
}
