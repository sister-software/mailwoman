/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The report an operator reads. Every section states what the admitted records support and lists each
 *   unresolved question with the record that would resolve it. Wording rules: an unresolved total is
 *   written as unresolved with its conflicting values. A source-present empty reading is written as the
 *   source having looked, with absence unknown.
 */

import type { UnitTotal } from "#counts"
import { LayerReadingClass } from "#coverage"
import type { Dossier } from "#dossier"

function totalLine(stage: string, total: UnitTotal): string {
	if (total.status === "resolved")
		return `- ${stage}: ${total.total} on ${total.at} (${total.parts.map((part) => part.evidence.source).join(", ")})`

	const values = total.conflicting.map((count) => `${count.count} per ${count.evidence.source}`).join(". ")

	return `- ${stage}: unresolved — ${total.reason}${values ? ` (${values})` : ""}`
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
	}

	return lines.join("\n")
}
