/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The report an operator reads. Every section states what the admitted records support and lists each
 *   unresolved question with the record that would resolve it. Wording rules: an unresolved total or
 *   position is written as unresolved with its conflicting values. A synthetic position is labeled
 *   synthetic. A source-present empty reading is written as the source having looked, with absence
 *   unknown. In the serviceability section every statement line opens with its kind, so a fact, a
 *   deduction, an estimate, a hypothesis and a decision never read alike. A reading that attaches to no
 *   building is listed once, after the building sections.
 */

import type { UnitTotal } from "#counts"
import { LayerReadingClass } from "#coverage"
import type { Dossier } from "#dossier"
import {
	type CheckResult,
	ExplanationKind,
	type ExplanationRanking,
	type ServiceabilityException,
	type Statement,
} from "#explanations"
import { outcomeStatements } from "#outcomes"
import type { ExtentMembership, PositionAnswer } from "#placement"
import type { SourceRecordID } from "#sources"

/**
 * Joins words as English prose without a serial comma: `a, b and c`.
 */
const PROSE_LIST = new Intl.ListFormat("en-GB", { style: "long", type: "conjunction" })

function statementLine(statement: Statement, indent = ""): string {
	const sources = statement.sources.length ? ` (${statement.sources.join(", ")})` : ""

	return `${indent}- ${statement.kind}${sources}: ${statement.text}`
}

function rankingLine(ranking: ExplanationRanking): string {
	switch (ranking.kind) {
		case "ranked":
			return `Ranking by documented probability: ${ranking.order.map((entry) => `${entry.explanation} (${entry.probability})`).join(", ")}.`
		case "scenarios": {
			const named = `The ${PROSE_LIST.format(ranking.undocumented)} ${ranking.undocumented.length === 1 ? "explanation has" : "explanations have"}`

			return `Ranking: none. ${named} no documented probability, so each explanation states the next action if it holds and if it fails.`
		}
		case "none":
			return "Ranking: none. No explanation has a supporting record."
	}
}

/**
 * The lines for one exception.
 *
 * A resolved exception keeps its explanations and their investigations as a record
 * of what the evidence supported on its date.
 * It prints no next action, because no decision waits on it.
 */
function exceptionLines(exception: ServiceabilityException): string[] {
	const resolved = exception.resolution.length > 0
	const where = exception.vintage ? `at the ${exception.vintage} readings` : `as of ${exception.checkedAt}`
	const lines = [`Exception ${where}, ${resolved ? "resolved" : "open"}.`, ""]

	// An open exception's readings are the check's answer.
	// The report has already printed them.
	if (resolved) {
		lines.push(
			...[...exception.facts, ...exception.deductions, ...exception.resolution].map((entry) => statementLine(entry)),
			""
		)
	}

	lines.push(
		`Explanations checked: ${PROSE_LIST.format(Object.values(ExplanationKind))}.`,
		`Checked without a supporting record: ${PROSE_LIST.format(exception.unsupported) || "none"}.`,
		""
	)

	for (const explanation of exception.explanations) {
		lines.push(`- explanation: ${explanation.kind}`, statementLine(explanation.hypothesis, "  "), "  - supporting:")
		lines.push(...explanation.supporting.map((entry) => statementLine(entry, "    ")))

		if (explanation.conflicting.length) {
			lines.push("  - conflicting:", ...explanation.conflicting.map((entry) => statementLine(entry, "    ")))
		} else {
			lines.push("  - conflicting: none on record")
		}

		lines.push(
			...explanation.missing.map((record) => `  - missing: ${record}`),
			`  - investigate: ${explanation.investigation.action}`
		)

		if (!resolved) {
			lines.push(
				`  - if it holds: ${explanation.investigation.ifHolds}`,
				`  - if it fails: ${explanation.investigation.ifFails}`
			)
		}
	}

	if (exception.explanations.length) {
		lines.push("")
	}

	lines.push(
		resolved
			? "Ranking: none. The exception is resolved, so no next action depends on its explanations."
			: rankingLine(exception.ranking),
		""
	)

	if (exception.estimates.length) {
		lines.push(...exception.estimates.map((entry) => statementLine(entry)), "")
	}

	return lines
}

function checkLines(result: CheckResult, asOf: string): string[] {
	const lines = [
		`#### Check ${result.check.id}: ${result.check.layer} keyed at ${result.check.extent}`,
		"",
		`Answer as of ${asOf}:`,
		"",
		...result.answer.map((entry) => statementLine(entry)),
		"",
	]

	if (result.exception) {
		lines.push(...exceptionLines(result.exception))
	}

	if (result.decisions.length) {
		lines.push("Decisions and outcomes:", "", ...result.decisions.map((entry) => statementLine(entry)), "")
	} else {
		lines.push("Decisions and outcomes: none on record.", "")
	}

	return lines
}

function totalLine(stage: string, total: UnitTotal): string {
	if (total.status === "resolved")
		return `- ${stage}: ${total.total} on ${total.at} (${total.parts.map((part) => part.evidence.source).join(", ")})`

	const values = total.conflicting.map((count) => `${count.count} per ${count.evidence.source}`).join(". ")

	return `- ${stage}: unresolved — ${total.reason}${values ? ` (${values})` : ""}`
}

function positionLine(position: PositionAnswer): string {
	const synthetic = (flag: boolean) => (flag ? ", synthetic" : "")

	if (position.status === "resolved") {
		const sources = [...new Set(position.positions.map((entry) => entry.evidence.source))].join(", ")

		return `Position: ${position.latitude}, ${position.longitude} (${sources})${synthetic(position.synthetic)}`
	}

	const values = position.conflicting
		.map((entry) => `${entry.latitude}, ${entry.longitude} per ${entry.evidence.source}${synthetic(entry.synthetic)}`)
		.join(". ")

	return `Position: unresolved — ${position.reason}${values ? ` (${values})` : ""}`
}

/**
 * Each extent with the records that place the building in it.
 */
function extentsLine(memberships: readonly ExtentMembership[]): string {
	const sources = new Map<string, Set<SourceRecordID>>()

	for (const membership of memberships) {
		sources.set(membership.extent, (sources.get(membership.extent) ?? new Set()).add(membership.evidence.source))
	}

	const extents = [...sources].map(([extent, cited]) => `${extent} (${[...cited].join(", ")})`)

	return `Extents: ${extents.join(", ") || "none"}`
}

function readingLine(reading: {
	layer: string
	extent: string
	surveyedAt?: string
	class: LayerReadingClass
}): string {
	const vintage = reading.surveyedAt ? ` as of ${reading.surveyedAt}` : ""

	switch (reading.class) {
		case LayerReadingClass.Records:
			return `- ${reading.layer} over ${reading.extent}${vintage}: records present`
		case LayerReadingClass.SurveyedEmpty:
			return `- ${reading.layer} over ${reading.extent}${vintage}: surveyed, zero records. Absence is established for the surveyed extent`
		case LayerReadingClass.SourcePresentEmpty:
			return `- ${reading.layer} over ${reading.extent}${vintage}: the source looked and found no record; absence is unknown`
		case LayerReadingClass.Conflicting:
			return `- ${reading.layer} over ${reading.extent}${vintage}: conflicting readings. See unresolved questions`
		case LayerReadingClass.Unknown:
			return `- ${reading.layer} over ${reading.extent}${vintage}: no survey. Unknown`
	}
}

export function renderReport(dossier: Dossier): string {
	const lines: string[] = [
		`# Building dossier as of ${dossier.asOf}`,
		"",
		"## Records",
		"",
		`Admitted (${dossier.admitted.length}): ${dossier.admitted.join(", ") || "none"}`,
		`Excluded, available after the cutoff (${dossier.excluded.length}): ${dossier.excluded.map((record) => `${record.id} (available ${record.availableAt})`).join(", ") || "none"}`,
		`Undated, no availability date (${dossier.undated.length}): ${dossier.undated.join(", ") || "none"}`,
		"",
	]

	for (const section of dossier.buildings) {
		lines.push(`## ${section.building.label}`, "")

		lines.push(
			`Identifiers: ${section.building.externalIDs.map((id) => `${id.namespace} ${id.value}`).join(", ") || "application id only"}`
		)

		lines.push(
			`Entrances: ${section.entrances.length}. Aliases: ${section.aliases.map((alias) => `"${alias.text}" (${alias.resolution.kind})`).join(", ") || "none"}`,
			positionLine(section.position),
			extentsLine(section.memberships),
			""
		)

		lines.push("### Units", "", ...Object.entries(section.counts).map(([stage, total]) => totalLine(stage, total)), "")

		lines.push(
			"### Events",
			"",
			...section.events.map(
				(event) =>
					`- ${event.kind} on ${event.date ?? "an unknown date"} (${event.parties.map((party) => party.name).join(", ")}. Scope ${event.scope.join(", ")})`
			),
			""
		)

		lines.push(
			"### Access",
			"",
			`Permissions: ${section.permissions.map((event) => `${event.parties[0]?.name ?? "unnamed"} for ${event.scope.join(", ")}`).join(". ") || "none on record"}`
		)

		lines.push(
			`Roles with known signing authority: ${section.authority.known.map((relation) => `${relation.organization} (${relation.role}, ${relation.signingAuthority})`).join(". ") || "none"}`
		)

		lines.push(
			`Roles with unknown signing authority: ${section.authority.unknown.map((relation) => `${relation.organization} (${relation.role})`).join(". ") || "none"}`,
			""
		)

		lines.push(
			"### Construction",
			"",
			...section.windows.map(
				(window) =>
					`- ${window.stage}: ${window.start ?? "unknown start"} to ${window.end ?? "no end stated"} (${window.evidence.source})`
			),
			""
		)

		lines.push(
			"### Providers",
			"",
			...section.availability.map(
				(entry) => `- ${entry.provider} ${entry.product}: ${entry.answer.status} on ${dossier.asOf}`
			),
			""
		)

		lines.push("### Layer readings", "", ...section.readings.map(readingLine), "")
		lines.push("### Unresolved", "")

		for (const item of section.unresolved) {
			lines.push(`- ${item.question}`)

			if (item.candidates.length) {
				lines.push(`  - candidates: ${item.candidates.join(". ")}`)
			}

			lines.push(`  - would resolve: ${item.missingRecord}`)
		}

		lines.push("")

		if (section.checks.length) {
			lines.push("### Serviceability checks", "")

			for (const result of section.checks) {
				lines.push(...checkLines(result, dossier.asOf))
			}
		}
	}

	lines.push("## Unplaced layer readings", "")

	if (dossier.unplaced.length) {
		lines.push(
			"Neither a subject nor an admitted membership places these readings at a building, so no building's section shows them.",
			""
		)

		for (const reading of dossier.unplaced) {
			lines.push(
				`${readingLine(reading)} (${reading.sources.join(", ")})`,
				`  - would resolve: a record that places a building in ${reading.extent}`
			)
		}

		lines.push("")
	} else {
		lines.push("Every admitted reading attaches to a building.", "")
	}

	if (dossier.buildings.some((section) => section.checks.length)) {
		lines.push(
			"## Operator outcomes",
			"",
			...outcomeStatements(dossier.outcomes).map((entry) => statementLine(entry)),
			""
		)
	}

	return lines.join("\n")
}
