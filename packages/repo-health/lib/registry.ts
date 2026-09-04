/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The registry of repository health checks — the ONLY executable entry point of this package, and the file knip
 *   treats as such. A check that is not listed here is dead code and knip reports it. `mwops health <id>` and
 *   `mwops health all` iterate this array.
 */

import type { RepoCheck } from "#check"

/**
 * Every health check, in the order `mwops health all` runs them. Empty at the scaffold: the checks under `scripts/`
 * move in one by one (`verify-exports`, `verify-version-sync`, `verify-test-contract`, `node-modules-reacharound`, the
 * debt counters, `vocab-census`), and `scripts/` loses a file for each.
 */
export const checks: ReadonlyArray<RepoCheck> = []

export function findCheck(id: string): RepoCheck | undefined {
	return checks.find((check) => check.id === id)
}
