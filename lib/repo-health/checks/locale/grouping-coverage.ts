// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `grouping-coverage` check: each member of each country grouping, and
 *   whether it holds a cited layout, training rows in its own address form,
 *   held-out evaluation coverage, gauntlet board rows and a support promise.
 *
 *   The check reads `groupingCoverage` in `mailwoman/tools/coverage`, the function the coverage
 *   page (`docs/articles/reference/coverage.mdx`) is generated from, so the page and the check agree.
 *   A tier in `grouping-requirements.json` requires every listed column of every member,
 *   and its `debt` is the count of missing cells measured when the tier was registered.
 *
 *   A tier whose count rises above its debt fails, and a tier whose count fell warns
 *   until the debt is lowered.
 *   A grouping without a tier is reported as a warning.
 *
 *   The corpus counts come from the census cache on the data root.
 *   The check never counts a corpus: on a data root that holds a corpus, a missing
 *   or outdated cache is an error naming the command that refreshes it.
 *
 *   A host whose data root holds no corpus, as CI's GitHub-hosted lint job's doesn't,
 *   gets one warning that the coverage is unmeasured there, so the ratchet holds
 *   on the lab host and the direct-push preflight.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { isoDate } from "@mailwoman/core/utils"
import {
	corpusCensusPath,
	GROUPING_COVERAGE_COLUMNS,
	GROUPING_REQUIREMENTS_PATH,
	type GroupingCoverage,
	groupingCoverage,
	type GroupingMemberCoverage,
	readGroupingRequirements,
	repositoryCoverageReport,
} from "mailwoman/tools/coverage"
import {
	newestReleaseSpecVersion,
	readRoleCollections,
	type RoleCollections,
} from "mailwoman/tools/eval-harness/heldout/dataset/coverage/collections"
import { relative } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"

/**
 * One member as a details line: its code, how it was read, and each column's holding.
 */
function memberLine(member: GroupingMemberCoverage): string {
	const via =
		member.readAs.length === 1 && member.readAs[0] === member.code
			? ""
			: ` (read as ${member.readAs.join(" + ") || "nothing"})`

	if (!member.cells) return `${member.code}${via}: unreadable`

	const sum = (pick: (holding: GroupingMemberCoverage["holdings"][number]) => number) =>
		member.holdings.reduce((total, holding) => total + pick(holding), 0)

	const cells = [
		`layout ${member.cells.citedLayout ? "cited" : "MISSING"}`,
		`address-form rows ${member.cells.addressFormRows ? sum((h) => h.addressFormRows).toLocaleString() : "MISSING"}`,
		`held out ${member.cells.heldOut ? `${sum((h) => h.heldOutAddresses.confirmation)} confirmation / ${sum((h) => h.heldOutAddresses.development)} development` : "MISSING"}`,
		`board ${member.cells.board ? `${sum((h) => h.boardPassedRows)}/${sum((h) => h.boardRows)}` : "MISSING"}`,
		`promise ${member.cells.promise ? member.holdings.map((h) => h.promise).join("+") : "MISSING"}`,
	]

	return `${member.code}${via}: ${cells.join(", ")}`
}

/**
 * Each required column's missing members as details lines.
 */
function gapLines(grouping: GroupingCoverage): string[] {
	return GROUPING_COVERAGE_COLUMNS.filter((column) => grouping.tier?.requires.includes(column)).map((column) => {
		const missing = grouping.gaps.filter((gap) => gap.column === column).map((gap) => gap.code)

		return `missing ${column}: ${missing.length ? missing.join(" ") : "none"}`
	})
}

/**
 * Reports each tier's missing cells against its debt, and each other grouping's holdings.
 */
export const groupingCoverageCheck: RepoCheck = {
	id: "grouping-coverage",
	description:
		"Every member of a G7, G20, IMF-advanced, OECD or EU tier holds a cited layout, address-form training rows, held-out evaluation coverage, board rows and a support promise, and a tier's missing cells never rise above its debt.",
	async run(context) {
		const requirementsFile = relative(context.repoRoot, GROUPING_REQUIREMENTS_PATH)

		// A host without a corpus, such as a GitHub-hosted runner, can't measure the corpus or held-out columns.
		// It reports the coverage unmeasured rather than grading members against counts it never read.
		if (!(await pathExists(corpusCensusPath())) && !(await pathExists(dataRootPath("corpus", "versioned")))) {
			return [
				{
					severity: DiagnosticSeverity.Warning,
					file: requirementsFile,
					line: null,
					message: `Grouping coverage is unmeasured on this host: the data root holds neither the corpus census (${corpusCensusPath()}) nor a corpus. Run the check on a host that holds the corpus.`,
					details: null,
				},
			]
		}

		let groupings: GroupingCoverage[]
		let heldOut: RoleCollections

		try {
			heldOut = await readRoleCollections(await newestReleaseSpecVersion())

			groupings = groupingCoverage({
				report: await repositoryCoverageReport({ countWhenUncached: false }),
				heldOut,
				requirements: await readGroupingRequirements(),
				at: isoDate(),
			})
		} catch (error) {
			return [
				{
					severity: DiagnosticSeverity.Error,
					file: requirementsFile,
					line: null,
					message: `The grouping coverage couldn't be read: ${error instanceof Error ? error.message : String(error)}`,
					details: null,
				},
			]
		}

		const diagnostics: Diagnostic[] = [
			{
				severity: DiagnosticSeverity.Warning,
				file: requirementsFile,
				line: null,
				message: `The held-out column read the ${heldOut.collections.length} collections of release specification ${heldOut.specVersion}'s development and confirmation roles.`,
				details: heldOut.collections.map((collection) => `${collection.role}: ${collection.id} (${collection.path})`),
			},
		]

		for (const grouping of groupings) {
			if (grouping.blockedBy.length) continue

			const members = grouping.members.map(memberLine)
			const { tier } = grouping

			if (!tier) {
				diagnostics.push({
					severity: DiagnosticSeverity.Warning,
					file: requirementsFile,
					line: null,
					message: `${grouping.id} (${grouping.name}) holds no tier, so its ${grouping.members.length} members are reported only.`,
					details: members,
				})

				continue
			}

			const missing = grouping.gaps.length
			const cells = grouping.members.length * tier.requires.length

			if (missing > tier.debt) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					file: requirementsFile,
					line: null,
					message: `${grouping.id} (${grouping.name}) misses ${missing} of ${cells} required cells, above its debt of ${tier.debt}. Restore the lost coverage; the debt never rises.`,
					details: [...gapLines(grouping), ...members],
				})
			} else if (missing < tier.debt) {
				diagnostics.push({
					severity: DiagnosticSeverity.Warning,
					file: requirementsFile,
					line: null,
					message: `${grouping.id} (${grouping.name}) misses ${missing} of ${cells} required cells, below its debt of ${tier.debt}. Lower its debt to ${missing}.`,
					details: [...gapLines(grouping), ...members],
				})
			} else if (missing) {
				diagnostics.push({
					severity: DiagnosticSeverity.Warning,
					file: requirementsFile,
					line: null,
					message: `${grouping.id} (${grouping.name}) misses ${missing} of ${cells} required cells, its debt.`,
					details: [...gapLines(grouping), ...members],
				})
			}

			if (grouping.unreadable.length) {
				diagnostics.push({
					severity: DiagnosticSeverity.Warning,
					file: requirementsFile,
					line: null,
					message: `${grouping.id} lists ${grouping.unreadable.length} member code(s) that are neither a jurisdiction nor in memberJurisdictions, each counted missing in every required column.`,
					details: grouping.unreadable,
				})
			}
		}

		return diagnostics
	},
}
