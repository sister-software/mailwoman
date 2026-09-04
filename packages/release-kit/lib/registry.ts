/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The registry of release operations — the ONLY executable entry point of this package, and the file knip treats as
 *   such. An operation that is not listed here is dead code and knip reports it, which is the property the retired
 *   `scripts/**` entry glob could never provide. Adapters (`@mailwoman/ops-cli`, the release MCP) iterate this array;
 *   they never import an operation module directly.
 */

import type { ReleaseOperation } from "#operation"

/**
 * Every release operation, in the order an adapter lists them. Empty at the scaffold: each family moves in from
 * `scripts/` as a registered operation, one PR per family, and the `scriptsUnreferenced` debt counter falls as it
 * does.
 */
export const operations: ReadonlyArray<ReleaseOperation<unknown, unknown>> = []

/**
 * Look an operation up by id, or `undefined`.
 */
export function findOperation(id: string): ReleaseOperation<unknown, unknown> | undefined {
	return operations.find((operation) => operation.id === id)
}
