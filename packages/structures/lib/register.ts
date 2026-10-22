/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Assembles the structure-source register from each jurisdiction's sources and audits it.
 *
 *   Ask {@linkcode publishProblems} whether a source may reach a published layer. A source is admitted only under an
 *   elected decision that permits every operation in {@link PUBLISH_OPERATIONS}.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { auditLicenseDecision, operationProblems } from "@mailwoman/core/license/decision"

import { CH_LICENSES, CH_SOURCES } from "#ch/sources"
import { DE_LICENSES, DE_SOURCES } from "#de/sources"
import { FI_LICENSES, FI_SOURCES } from "#fi/sources"
import { INTERNATIONAL_LICENSES, INTERNATIONAL_SOURCES } from "#international/sources"
import { JP_LICENSES, JP_SOURCES } from "#jp/sources"
import { NL_LICENSES, NL_SOURCES } from "#nl/sources"
import {
	INTERNATIONAL,
	PUBLISH_OPERATIONS,
	StructureOperation,
	type StructureSource,
	type StructureSourceRegister,
} from "#types"

/**
 * The register as the jurisdiction modules declare it.
 */
export const STRUCTURE_SOURCE_REGISTER: StructureSourceRegister = {
	sources: [...INTERNATIONAL_SOURCES, ...CH_SOURCES, ...DE_SOURCES, ...FI_SOURCES, ...JP_SOURCES, ...NL_SOURCES],
	licenses: [...INTERNATIONAL_LICENSES, ...CH_LICENSES, ...DE_LICENSES, ...FI_LICENSES, ...JP_LICENSES, ...NL_LICENSES],
}

/**
 * Returns every reason a source may not reach a published layer, or an empty array when it may.
 */
export function publishProblems(
	source: StructureSource,
	register: StructureSourceRegister = STRUCTURE_SOURCE_REGISTER,
	operations: readonly StructureOperation[] = PUBLISH_OPERATIONS
): string[] {
	const decision = register.licenses.find((entry) => entry.licenseID === source.license)

	return operationProblems(source.license, decision, operations)
}

/**
 * Returns every problem with the register's own records: duplicate or dangling ids,
 * a source id or region that disagrees with its jurisdiction, and each decision's audit.
 */
export function auditStructureRegister(register: StructureSourceRegister = STRUCTURE_SOURCE_REGISTER): string[] {
	const problems: string[] = []
	const sourceIDs = new Set<string>()
	const licenseIDs = new Set(register.licenses.map((decision) => decision.licenseID))
	const referenced = new Set(register.sources.map((source) => source.license))

	for (const source of register.sources) {
		const named = stringifyJSON(source.sourceID)

		if (sourceIDs.has(source.sourceID)) {
			problems.push(`source ${named} is declared twice`)
		}

		sourceIDs.add(source.sourceID)

		if (!source.sourceID.startsWith(`${source.jurisdiction}-`)) {
			problems.push(`source ${named} does not start with its jurisdiction ${stringifyJSON(source.jurisdiction)}`)
		}

		if (source.jurisdiction !== INTERNATIONAL && !/^[a-z]{2}$/.test(source.jurisdiction)) {
			problems.push(`source ${named} has jurisdiction ${stringifyJSON(source.jurisdiction)}, not an alpha-2 code`)
		}

		if (source.region && !source.region.startsWith(`${source.jurisdiction.toUpperCase()}-`)) {
			problems.push(`source ${named} has region ${stringifyJSON(source.region)} outside its jurisdiction`)
		}

		if (!licenseIDs.has(source.license)) {
			problems.push(`source ${named} points at license ${stringifyJSON(source.license)}, which is not declared`)
		}
	}

	const seenLicenses = new Set<string>()

	for (const decision of register.licenses) {
		const named = stringifyJSON(decision.licenseID)

		if (seenLicenses.has(decision.licenseID)) {
			problems.push(`license ${named} is declared twice`)
		}

		seenLicenses.add(decision.licenseID)

		if (!referenced.has(decision.licenseID)) {
			problems.push(`license ${named} is declared and no source points at it`)
		}

		problems.push(...auditLicenseDecision(decision, Object.values(StructureOperation)))
	}

	return problems
}
