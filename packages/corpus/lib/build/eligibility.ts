/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What the address-source register records about a row's source, read once per build.
 */

import { stringifyJSON } from "@mailwoman/core/json"

import { ingestEligibilityProblems, readAddressSourceRegister, type LicenseDecision } from "#source-register"
import type { CanonicalRow } from "#types"

/**
 * The key a row is looked up under: the adapter that emitted it and the jurisdiction it describes.
 *
 * The register scopes a source to one publisher in one jurisdiction,
 * so an adapter id by itself cannot address a record.
 * One adapter serves several: `ban` emits eleven jurisdictions from one schema
 * and each is its own source under its own license decision.
 */
export function sourceEligibilityKey(adapterID: string, iso2: string): string {
	return `${adapterID}:${iso2.toUpperCase()}`
}

/**
 * Every register source's ingest-eligibility reasons, keyed by the adapter
 * and jurisdiction of the rows that recorded it.
 *
 * A source declaring no `adapterID` is absent from the map, because no adapter emits it
 * and no row can arrive under it.
 * An empty array is the only value a caller may read as permission.
 * An absent key is refused rather than admitted.
 */
export async function readSourceEligibility(): Promise<ReadonlyMap<string, readonly string[]>> {
	const register = await readAddressSourceRegister()
	const keyed = new Map<string, readonly string[]>()

	for (const source of register.sources) {
		if (!source.adapterID) continue

		keyed.set(sourceEligibilityKey(source.adapterID, source.iso2), ingestEligibilityProblems(source, register))
	}

	return keyed
}

/**
 * The register's license decisions keyed by the label in a row.
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

			const key = sourceEligibilityKey(row.source, row.country)
			const cached = refused.get(key)

			if (cached) return cached

			const problems = eligibility.get(key) ?? [
				`no register source declares ${stringifyJSON(row.source)} as its adapter in ${stringifyJSON(row.country)}, ` +
					"so this row's publication has not been reviewed. Set `adapterID` on the source in " +
					"`source-resolutions.json` once a review has elected it.",
			]

			if (!problems.length) return null

			refused.set(key, problems)

			return problems
		},
	}
}
