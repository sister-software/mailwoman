/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What the address-source register says about a row's source, read once per build.
 */

import { stringifyJSON } from "@mailwoman/core/json"

import { ingestEligibilityProblems, readAddressSourceRegister, type LicenseDecision } from "#source-register/index"
import type { CanonicalRow } from "#types"

/**
 * Every register source's ingest-eligibility reasons keyed by the adapter id its rows carry.
 *
 * An empty array is the only value a caller may read as permission.
 * An absent source is refused rather than admitted.
 */
export async function readSourceEligibility(): Promise<ReadonlyMap<string, readonly string[]>> {
	const register = await readAddressSourceRegister()

	return new Map(register.sources.map((source) => [source.sourceID, ingestEligibilityProblems(source, register)]))
}

/**
 * The register's license decisions keyed by the label a row carries.
 *
 * An unmatched adapter label records a `null` decision rather than inventing one.
 */
export async function readRegisterDecisions(): Promise<ReadonlyMap<string, LicenseDecision>> {
	const register = await readAddressSourceRegister()

	return new Map(register.licenses.map((decision) => [decision.licenseID, decision]))
}

/**
 * Reads why a row's source may be refused from a release-eligible corpus.
 * Records each refused source.
 *
 * `refused` accumulates as rows arrive.
 * The build manifest reports the collected values.
 *
 * A build whose `eligibility` is `null` runs under the exploratory profile and every row reads eligible.
 */
export function createIneligibilityReader(eligibility: ReadonlyMap<string, readonly string[]> | null): {
	refused: Map<string, readonly string[]>
	read: (row: CanonicalRow) => readonly string[] | null
} {
	const refused = new Map<string, readonly string[]>()

	return {
		refused,
		read: (row) => {
			if (!eligibility) return null

			const cached = refused.get(row.source)

			if (cached) return cached

			const problems = eligibility.get(row.source) ?? [
				`the register names no source ${stringifyJSON(row.source)}, so nothing has been reviewed for it`,
			]

			if (!problems.length) return null

			refused.set(row.source, problems)

			return problems
		},
	}
}
