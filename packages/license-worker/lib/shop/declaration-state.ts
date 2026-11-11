/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The operator's write of a declared license's state. The worker exposes no administrative route, so the write
 *   reaches the remote ledger through `wrangler d1 execute` as one compare-and-set statement. That statement is the
 *   compare-and-set of the declaration machine's carrier in `shop.declaration-state`, the same condition
 *   `setDeclarationState` applies inside the worker.
 */

import { LicenseState } from "#ledger/schema"

/**
 * A license id as `newLicenseID` mints it: `lic_` and 22 URL-safe characters.
 */
const LICENSE_ID = /^lic_[A-Za-z0-9_-]{22}$/u

const STATES: ReadonlySet<string> = new Set(Object.values(LicenseState))

/**
 * An ISO 8601 UTC instant, as the ledger stamps `updated_at`.
 */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u

/**
 * The SQL that moves one declaration from `from` to `to`, applied only while the row still holds `from`.
 *
 * Every interpolated value is checked against its closed form first.
 * The statement then holds only a license id, two state names and a timestamp from the caller.
 *
 * @throws When the id, either state or the instant is not one of the forms the ledger writes.
 */
export function declarationStateStatement(lid: string, from: string, to: string, at: string): string {
	if (!LICENSE_ID.test(lid)) throw new Error(`${lid} is not a license id`)

	if (!STATES.has(from)) throw new Error(`${from} is not a license state`)

	if (!STATES.has(to)) throw new Error(`${to} is not a license state`)

	if (!INSTANT.test(at)) throw new Error(`${at} is not an ISO 8601 UTC instant`)

	return `UPDATE declarations SET license_state = '${to}', updated_at = '${at}' WHERE lid = '${lid}' AND license_state = '${from}'`
}
