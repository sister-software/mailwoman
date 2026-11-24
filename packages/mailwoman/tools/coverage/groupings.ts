// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file What each member of each country grouping holds, read from each holding's own reader.
 *
 *   The coverage page (`jurisdiction-coverage.run.ts`) and the `grouping-coverage` health check both call
 *   {@linkcode groupingCoverage}, so the page and the check can't disagree.
 *   Each column reads its owner: the cited layout from `layoutCitationForCountry` in codex, the address-form
 *   rows and the board rows from {@linkcode censusCoverage}, held-out evaluation coverage from the manifests of
 *   the collections the newest release specification's development and confirmation roles score
 *   (`readRoleCollections`), and the support promise from `SUPPORT_PROMISES`.
 *   The tiers' requirements and their debt are the data in `grouping-requirements.json`.
 */

import { layoutCitationForCountry } from "@mailwoman/codex/address/layouts"
import { POSTAL_REGIMES } from "@mailwoman/codex/country/postal-regimes"
import { countriesOfGrouping } from "@mailwoman/codex/country/sets"
import { SUPPORT_DEPTHS, SUPPORT_PROMISES, type SupportDepth } from "@mailwoman/codex/support"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { GROUPING_IDS, type GroupingID } from "@mailwoman/registry/artifacts/groupings/groupings"
import { getGrouping, groupingMembers } from "@mailwoman/registry/groupings"

import type { CountryCoverage, CoverageReport } from "#tools/coverage/census"
import type { RoleCollections } from "#tools/eval-harness/heldout/dataset/coverage/collections"
import type { EvaluationRole } from "#tools/eval-harness/release/requirements"

/**
 * The holdings a grouping member is read for.
 */
export const GroupingCoverageColumn = {
	/**
	 * The rendered address layout cites a primary document.
	 */
	CitedLayout: "citedLayout",
	/**
	 * The training corpora hold at least one row in the country's own address
	 * form (`CountryCoverage.addressFormRows`).
	 */
	AddressFormRows: "addressFormRows",
	/**
	 * A collection of the newest specification's development or confirmation role
	 * samples at least one address row.
	 */
	HeldOut: "heldOut",
	/**
	 * The gauntlet board holds at least one row.
	 */
	Board: "board",
	/**
	 * `promises.json` holds a support promise.
	 */
	Promise: "promise",
} as const

export type GroupingCoverageColumn = (typeof GroupingCoverageColumn)[keyof typeof GroupingCoverageColumn]

/**
 * Every column, in the order the page and the check print them.
 */
export const GROUPING_COVERAGE_COLUMNS: readonly GroupingCoverageColumn[] = Object.values(GroupingCoverageColumn)

/**
 * One tier: a grouping whose members must hold every listed column.
 */
export interface GroupingTier {
	grouping: GroupingID
	requires: GroupingCoverageColumn[]
	/**
	 * The count of member cells the tier lacked on `debtMeasuredOn`.
	 * The count may fall and never rise.
	 */
	debt: number
}

/**
 * A member code read through the jurisdictions its publisher states it covers.
 */
export interface MemberJurisdictions {
	name: string
	jurisdictions: string[]
	/**
	 * The publisher's statement of what the code covers, with its URL and the words quoted.
	 */
	source: string
}

export interface GroupingRequirements {
	debtMeasuredOn: string
	tiers: GroupingTier[]
	memberJurisdictions: Record<string, MemberJurisdictions>
}

/**
 * The repository path of the requirements table.
 */
export const GROUPING_REQUIREMENTS_PATH = workspacePath("mailwoman", "tools", "coverage", "grouping-requirements.json")

/**
 * Reads the requirements table.
 *
 * @throws When a tier lists an unknown grouping or column, so a typo can't drop a requirement.
 */
export async function readGroupingRequirements(): Promise<GroupingRequirements> {
	const table = await readLocalJSONFile<GroupingRequirements>(GROUPING_REQUIREMENTS_PATH)

	for (const tier of table.tiers) {
		if (!(GROUPING_IDS as readonly string[]).includes(tier.grouping)) {
			throw new Error(`${GROUPING_REQUIREMENTS_PATH} lists an unknown grouping "${tier.grouping}"`)
		}

		const unknown = tier.requires.filter((column) => !GROUPING_COVERAGE_COLUMNS.includes(column))

		if (unknown.length) {
			throw new Error(`${GROUPING_REQUIREMENTS_PATH}: tier ${tier.grouping} requires unknown column(s) ${unknown.join(", ")}`)
		}
	}

	return table
}

/**
 * The deepest support promise per country, across every input language and script.
 */
export function deepestSupportPromises(): Map<string, SupportDepth> {
	const deepest = new Map<string, SupportDepth>()

	for (const promise of SUPPORT_PROMISES) {
		const earlier = deepest.get(promise.country)

		if (!earlier || SUPPORT_DEPTHS.indexOf(promise.depth) < SUPPORT_DEPTHS.indexOf(earlier)) {
			deepest.set(promise.country, promise.depth)
		}
	}

	return deepest
}

/**
 * What one jurisdiction holds, column by column.
 */
export interface JurisdictionHoldings {
	code: string
	cells: Record<GroupingCoverageColumn, boolean>
	addressFormRows: number
	/**
	 * Held-out address rows each evaluation role's collections sample, summed per role.
	 */
	heldOutAddresses: Record<EvaluationRole, number>
	boardRows: number
	boardPassedRows: number
	promise: SupportDepth | null
}

/**
 * One grouping member and what it holds.
 */
export interface GroupingMemberCoverage {
	code: string
	/**
	 * The jurisdictions read for this member: the code itself, its publisher's stated jurisdictions,
	 * or none when the code is neither a jurisdiction nor in `memberJurisdictions`.
	 */
	readAs: string[]
	/**
	 * `null` for an unreadable member.
	 *
	 * The page prints it as unreadable, and a tier counts each of its required cells
	 * as a gap, because no reading shows the member covered.
	 */
	cells: Record<GroupingCoverageColumn, boolean> | null
	holdings: JurisdictionHoldings[]
}

export interface GroupingCoverage {
	id: GroupingID
	name: string
	blockedBy: readonly string[]
	members: GroupingMemberCoverage[]
	tier: GroupingTier | null
	/**
	 * Each required cell a member lacks, in member order then column order.
	 */
	gaps: Array<{ code: string; column: GroupingCoverageColumn }>
	unreadable: string[]
}

/**
 * The inputs {@linkcode groupingCoverage} reads.
 */
export interface GroupingCoverageInputs {
	report: CoverageReport
	heldOut: RoleCollections
	requirements: GroupingRequirements
	/**
	 * The membership date, `YYYY-MM-DD`.
	 */
	at: string
}

/**
 * The postal regimes' codes.
 *
 * They hold the codes outside ISO 3166-1 that the coverage page enumerates as jurisdictions, such as `XK`.
 */
const OPERATIONAL_CODES: ReadonlySet<string> = new Set(POSTAL_REGIMES.flatMap((regime) => regime.iso2))

/**
 * Reads what one jurisdiction holds.
 */
export function jurisdictionHoldings(
	code: string,
	measured: ReadonlyMap<string, CountryCoverage>,
	heldOut: RoleCollections,
	promises: ReadonlyMap<string, SupportDepth>
): JurisdictionHoldings {
	const coverage = measured.get(code) ?? null
	const heldOutAddresses: Record<EvaluationRole, number> = { development: 0, confirmation: 0 }

	for (const collection of heldOut.collections) {
		heldOutAddresses[collection.role] += collection.addressRows[code] ?? 0
	}

	const promise = promises.get(code) ?? null

	return {
		code,
		cells: {
			citedLayout: layoutCitationForCountry(code) != null,
			addressFormRows: (coverage?.addressFormRows ?? 0) > 0,
			heldOut: heldOutAddresses.development + heldOutAddresses.confirmation > 0,
			board: (coverage?.boardRows ?? 0) > 0,
			promise: promise != null,
		},
		addressFormRows: coverage?.addressFormRows ?? 0,
		heldOutAddresses,
		boardRows: coverage?.boardRows ?? 0,
		boardPassedRows: coverage?.boardPassedRows ?? 0,
		promise,
	}
}

/**
 * Reads every grouping's members on `at` and what each member holds, with each tier's gaps.
 */
export function groupingCoverage(inputs: GroupingCoverageInputs): GroupingCoverage[] {
	const { report, heldOut, requirements, at } = inputs
	const measured = new Map(report.countries.map((country) => [country.country, country]))
	const promises = deepestSupportPromises()
	const tiers = new Map(requirements.tiers.map((tier) => [tier.grouping, tier]))

	return GROUPING_IDS.map((id): GroupingCoverage => {
		const grouping = getGrouping(id)
		const tier = tiers.get(id) ?? null

		if (grouping.blockedBy.length) {
			return { id, name: grouping.name, blockedBy: grouping.blockedBy, members: [], tier, gaps: [], unreadable: [] }
		}

		const listed = groupingMembers(id, { at })
		// `outside` holds the members `CountryISO2` doesn't, such as the World Bank's `XK` and `JG`.
		const { outside } = countriesOfGrouping(id, at, listed)
		const nonISO = new Set(outside)

		const members = listed.map(({ code }): GroupingMemberCoverage => {
			const readAs =
				!nonISO.has(code) || OPERATIONAL_CODES.has(code)
					? [code]
					: (requirements.memberJurisdictions[code]?.jurisdictions ?? [])

			const holdings = readAs.map((jurisdiction) => jurisdictionHoldings(jurisdiction, measured, heldOut, promises))

			const cells = holdings.length
				? (Object.fromEntries(
						GROUPING_COVERAGE_COLUMNS.map((column) => [column, holdings.every((held) => held.cells[column])])
					) as Record<GroupingCoverageColumn, boolean>)
				: null

			return { code, readAs, cells, holdings }
		})

		const gaps = tier
			? members.flatMap((member) =>
					tier.requires.filter((column) => !member.cells?.[column]).map((column) => ({ code: member.code, column }))
				)
			: []

		return {
			id,
			name: grouping.name,
			blockedBy: grouping.blockedBy,
			members,
			tier,
			gaps,
			unreadable: members.filter((member) => !member.cells).map((member) => member.code),
		}
	})
}
