/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The value a corpus row's `license` column holds: an SPDX identifier, or a `LicenseRef-*` id, taken from the
 *   license decisions of the register sources `corpus-source-inputs.json` maps the row's source to.
 *
 *   A decision with an elected SPDX identifier contributes that identifier. Any other decision contributes
 *   `LicenseRef-<licenseID>`, so an unchecked or refused decision reads as its own decision key rather than as a
 *   grant. A source reading several register sources holds their distinct ids joined by ` AND `, the SPDX
 *   expression for terms that all apply. A source the table does not map, or maps to no register source, has no
 *   license id, and a writer refuses its rows rather than writing a placeholder.
 *
 *   A producer's own statement of its terms, such as `OS OpenData GB tuples (OGL-UK-3.0), rendered native-order`,
 *   is not a license id. The parquet writers record it in the file's `RECORD.json` under `licenseStatements`.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"

import {
	type CorpusSourceInputs,
	type CorpusSourceInputsFile,
	type CorpusSourceMapping,
	corpusSourceInputsPath,
	indexCorpusSourceInputs,
} from "#source-register/corpus-inputs"
import { addressSourceRegisterPath } from "#source-register/register"
import { type AddressSourceRegister, LicenseReviewState, type LicenseDecision } from "#source-register/types"

/**
 * The SPDX prefix for a license the SPDX list omits.
 */
export const LICENSE_REF_PREFIX = "LicenseRef-"

/**
 * The id one license decision contributes to a row's `license` column.
 */
export function decisionLicenseID(decision: LicenseDecision): string {
	if (decision.state === LicenseReviewState.Elected && decision.spdx) return decision.spdx

	return `${LICENSE_REF_PREFIX}${decision.licenseID}`
}

/**
 * The `license` value for rows of a source, or `null` when the mapping lists no register source.
 *
 * @throws When an input points at a license decision the register does not declare.
 */
export function mappingLicenseID(
	mapping: CorpusSourceMapping,
	decisions: ReadonlyMap<string, LicenseDecision>
): string | null {
	const ids = new Set<string>()

	for (const input of mapping.inputs) {
		const decision = decisions.get(input.license)

		if (!decision) {
			throw new Error(
				`corpus source input ${stringifyJSON(input.registerSource)} names license ${stringifyJSON(input.license)}, ` +
					"which the register does not declare"
			)
		}

		ids.add(decisionLicenseID(decision))
	}

	if (!ids.size) return null

	return [...ids].toSorted().join(" AND ")
}

/**
 * Answers the `license` value for each corpus source.
 */
export interface RowLicenses {
	/**
	 * The license id for rows of `source`, or `null` when the source has none.
	 */
	licenseOf(source: string): string | null
	/**
	 * The license id for rows of `source`.
	 *
	 * @throws When the source has none, naming `context`.
	 */
	require(source: string, context: string): string
}

/**
 * Builds the lookup over an already-read register and source table.
 */
export function createRowLicenses(register: AddressSourceRegister, inputs: CorpusSourceInputs): RowLicenses {
	const decisions = new Map(register.licenses.map((decision) => [decision.licenseID, decision]))
	const known = new Map<string, string | null>()

	const licenseOf = (source: string): string | null => {
		if (known.has(source)) return known.get(source)!

		const resolved = inputs.resolve(source)
		const id = resolved ? mappingLicenseID(resolved.mapping, decisions) : null

		known.set(source, id)

		return id
	}

	return {
		licenseOf,
		require(source, context) {
			const id = licenseOf(source)

			if (id) return id

			const mapped = inputs.resolve(source)

			throw new Error(
				`${context}: rows of ${stringifyJSON(source)} have no license id, because ` +
					(mapped
						? "corpus-source-inputs.json maps the source to no register source, only to authored inputs. "
						: "corpus-source-inputs.json does not map the source. ") +
					"A row's license column holds the SPDX or LicenseRef id of its register inputs' decisions, so the row " +
					"is refused rather than written with a placeholder. Map the source to the register sources it reads."
			)
		},
	}
}

let committed: Promise<RowLicenses> | null = null

/**
 * The lookup over the committed register and `corpus-source-inputs.json`.
 *
 * It reads both files without auditing them, because the audit runs where a build admits its sources.
 */
export function committedRowLicenses(): Promise<RowLicenses> {
	committed ??= Promise.all([
		readLocalJSONFile<AddressSourceRegister>(addressSourceRegisterPath()),
		readLocalJSONFile<CorpusSourceInputsFile>(corpusSourceInputsPath()),
	]).then(([register, file]) => createRowLicenses(register, indexCorpusSourceInputs(file)))

	return committed
}
