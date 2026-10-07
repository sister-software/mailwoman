/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The report an operator reads, assembled from line records. `reportLines` returns each line with its
 *   text, the part of the report it belongs to, its kind and the source records behind it. `renderReport`
 *   prints the text of each record in order, one line per record, so the printed report and the records
 *   cannot disagree.
 *
 *   A conclusion states a value that admitted records supply, and its text cites each of those records.
 *   The citation follows the value it supports, in parentheses. An identifier without evidence is still a
 *   conclusion, and it prints the words `source unstated` where its citation would be. An absence states
 *   in words that no admitted record supplies a value. The sources part ends the report and gives each
 *   admitted record's publisher, title, URL and three dates.
 *
 *   Every section states what the admitted records support and lists each unresolved question with the
 *   record that would resolve it. An unresolved total or position is written as unresolved
 *   with its conflicting values. A synthetic position is labeled synthetic. A source-present empty reading
 *   is written as the source having looked, with absence unknown. In the serviceability section every
 *   statement line opens with its kind, so a fact, a deduction, an estimate, a hypothesis and a decision
 *   never read alike. A reading that attaches to no building is listed once, after the building sections.
 *
 *   Each claim line gives the claim's status, source record and evidence date beside its value, so an
 *   inferred value never reads as an observed one. The evidence date is the date the fact was observed.
 *   A record's availability and retrieval dates say when the record could be read, so neither dates a
 *   claim, and a claim with no observation date is printed as undated.
 */

import type { AvailabilityAnswer } from "#availability"
import type { Claim } from "#claims"
import type { UnitTotal } from "#counts"
import { LayerReadingClass } from "#coverage"
import type { BuildingSection, Dossier, Unresolved } from "#dossier"
import type { CommercialEvent, OrganizationRelation } from "#events"
import {
	type CheckResult,
	ExplanationKind,
	type ExplanationRanking,
	proseList,
	type ServiceabilityException,
	type Statement,
	StatementKind,
} from "#explanations"
import type { EntityID } from "#identifiers"
import type { AliasResolution } from "#links"
import { outcomeStatements } from "#outcomes"
import type { ExtentMembership, PositionAnswer } from "#placement"
import { distinctSources, type SourceRecord, type SourceRecordID } from "#sources"
import type { ISODate } from "#time"

/**
 * What a report line states, as wire values.
 *
 * A heading titles a part or a block and states no value of its own.
 * A blank line separates two blocks.
 *
 * A conclusion states at least one value that admitted records supply, and cites them.
 * An absence states in words that no admitted record supplies a value.
 *
 * A question is an unresolved question, its candidate answers, or a hypothesis.
 * A guidance line states what would resolve a question or test an explanation.
 *
 * A derivation states what a derived or inferred claim rests on, or its explanation.
 * A source line lists source records, in the records header or in the sources part.
 */
export const ReportLineKind = {
	Heading: "heading",
	Blank: "blank",
	Conclusion: "conclusion",
	Absence: "absence",
	Question: "question",
	Guidance: "guidance",
	Derivation: "derivation",
	Source: "source",
} as const

export type ReportLineKind = (typeof ReportLineKind)[keyof typeof ReportLineKind]

/**
 * The parts of a report, as wire values.
 *
 * The title and the records header open the report.
 * Each building's section opens with its heading and its identity lines.
 *
 * The section's other parts follow in the order this object lists them.
 * The unplaced readings, the operator outcomes and the sources part close the report.
 */
export const ReportPart = {
	Title: "title",
	Records: "records",
	Building: "building",
	Units: "units",
	Events: "events",
	Access: "access",
	Construction: "construction",
	Providers: "providers",
	Readings: "readings",
	Claims: "claims",
	Unresolved: "unresolved",
	Checks: "checks",
	Unplaced: "unplaced",
	Outcomes: "outcomes",
	Sources: "sources",
} as const

export type ReportPart = (typeof ReportPart)[keyof typeof ReportPart]

/**
 * One line of a report.
 */
export interface ReportLine {
	/**
	 * The line as the report prints it.
	 */
	text: string
	part: ReportPart
	kind: ReportLineKind
	/**
	 * The building whose section holds the line.
	 * A line outside every building's section has none.
	 */
	building?: EntityID
	/**
	 * The source records behind the line, each once, in the order the line first cites them.
	 *
	 * A conclusion's text cites every record in this list.
	 */
	sources: readonly SourceRecordID[]
}

/**
 * The citation that follows a value: its source records in parentheses,
 * or the words `source unstated` when no record is given for it.
 */
function cite(sources: readonly SourceRecordID[]): string {
	return sources.length ? ` (${distinctSources(sources).join(", ")})` : " (source unstated)"
}

function line(
	part: ReportPart,
	kind: ReportLineKind,
	text: string,
	sources: readonly SourceRecordID[] = []
): ReportLine {
	return { text, part, kind, sources: distinctSources(sources) }
}

function heading(part: ReportPart, text: string): ReportLine {
	return line(part, ReportLineKind.Heading, text)
}

function blank(part: ReportPart): ReportLine {
	return line(part, ReportLineKind.Blank, "")
}

/**
 * A statement's line, opened by the statement's kind and the records the statement cites.
 *
 * A hypothesis is a question, and a statement marked as an absence is an absence.
 * Every other statement is a conclusion, and one that cites no record prints `source unstated`.
 */
function statementRecord(part: ReportPart, statement: Statement, indent = ""): ReportLine {
	const kind =
		statement.kind === StatementKind.Hypothesis
			? ReportLineKind.Question
			: statement.absence
				? ReportLineKind.Absence
				: ReportLineKind.Conclusion

	const cited = statement.sources.length || kind === ReportLineKind.Conclusion ? cite(statement.sources) : ""

	return line(part, kind, `${indent}- ${statement.kind}${cited}: ${statement.text}`, statement.sources)
}

function rankingRecord(ranking: ExplanationRanking): ReportLine {
	switch (ranking.kind) {
		case "ranked": {
			const sources = ranking.order.flatMap((entry) => entry.sources)
			const order = ranking.order.map((entry) => `${entry.explanation} (${entry.probability})`).join(", ")

			return line(
				ReportPart.Checks,
				ReportLineKind.Conclusion,
				`Ranking by documented probability: ${order}${cite(sources)}.`,
				sources
			)
		}
		case "scenarios": {
			const named = `The ${proseList(ranking.undocumented)} ${ranking.undocumented.length === 1 ? "explanation has" : "explanations have"}`

			return line(
				ReportPart.Checks,
				ReportLineKind.Absence,
				`Ranking: none. ${named} no documented probability, so each explanation states the next action if it holds and if it fails.`
			)
		}
		case "none":
			return line(ReportPart.Checks, ReportLineKind.Absence, "Ranking: none. No explanation has a supporting record.")
	}
}

/**
 * The lines for one exception.
 *
 * A resolved exception keeps its explanations and their investigations as a record
 * of what the evidence supported on its date.
 * It prints no next action, because no decision waits on it.
 */
function exceptionRecords(exception: ServiceabilityException): ReportLine[] {
	const part = ReportPart.Checks
	const resolved = exception.resolution.length > 0
	const where = exception.vintage ? `at the ${exception.vintage} readings` : `as of ${exception.checkedAt}`
	const lines = [heading(part, `Exception ${where}, ${resolved ? "resolved" : "open"}.`), blank(part)]

	// An open exception's readings are the check's answer.
	// The report has already printed them.
	if (resolved) {
		lines.push(
			...[...exception.facts, ...exception.deductions, ...exception.resolution].map((entry) =>
				statementRecord(part, entry)
			),
			blank(part)
		)
	}

	lines.push(
		heading(part, `Explanations checked: ${proseList(Object.values(ExplanationKind))}.`),
		// The line lists the kinds without a supporting record, an absence of support for each.
		// When every kind has one, the line introduces the explanations below and states no absence.
		exception.unsupported.length
			? line(part, ReportLineKind.Absence, `Checked without a supporting record: ${proseList(exception.unsupported)}.`)
			: heading(part, "Checked without a supporting record: none."),
		blank(part)
	)

	for (const explanation of exception.explanations) {
		lines.push(
			heading(part, `- explanation: ${explanation.kind}`),
			statementRecord(part, explanation.hypothesis, "  "),
			heading(part, "  - supporting:"),
			...explanation.supporting.map((entry) => statementRecord(part, entry, "    "))
		)

		if (explanation.conflicting.length) {
			lines.push(
				heading(part, "  - conflicting:"),
				...explanation.conflicting.map((entry) => statementRecord(part, entry, "    "))
			)
		} else {
			lines.push(line(part, ReportLineKind.Absence, "  - conflicting: none on record"))
		}

		lines.push(
			...explanation.missing.map((record) => line(part, ReportLineKind.Guidance, `  - missing: ${record}`)),
			line(part, ReportLineKind.Guidance, `  - investigate: ${explanation.investigation.action}`)
		)

		if (!resolved) {
			lines.push(
				line(part, ReportLineKind.Guidance, `  - if it holds: ${explanation.investigation.ifHolds}`),
				line(part, ReportLineKind.Guidance, `  - if it fails: ${explanation.investigation.ifFails}`)
			)
		}
	}

	if (exception.explanations.length) {
		lines.push(blank(part))
	}

	lines.push(
		resolved
			? line(
					part,
					ReportLineKind.Guidance,
					"Ranking: none. The exception is resolved, so no next action depends on its explanations."
				)
			: rankingRecord(exception.ranking),
		blank(part)
	)

	if (exception.estimates.length) {
		lines.push(...exception.estimates.map((entry) => statementRecord(part, entry)), blank(part))
	}

	return lines
}

function checkRecords(result: CheckResult, asOf: string): ReportLine[] {
	const part = ReportPart.Checks

	const lines = [
		heading(part, `#### Check ${result.check.id}: ${result.check.layer} keyed at ${result.check.extent}`),
		blank(part),
		heading(part, `Answer as of ${asOf}:`),
		blank(part),
		...result.answer.map((entry) => statementRecord(part, entry)),
		blank(part),
	]

	if (result.exception) {
		lines.push(...exceptionRecords(result.exception))
	}

	if (result.decisions.length) {
		lines.push(
			heading(part, "Decisions and outcomes:"),
			blank(part),
			...result.decisions.map((entry) => statementRecord(part, entry)),
			blank(part)
		)
	} else {
		lines.push(line(part, ReportLineKind.Absence, "Decisions and outcomes: none on record."), blank(part))
	}

	return lines
}

/**
 * A stage's unit total.
 *
 * A resolved total and a conflict between counts each cite their counts.
 * A stage without a count is an absence.
 */
function totalRecord(stage: string, total: UnitTotal): ReportLine {
	if (total.status === "resolved") {
		const sources = total.parts.map((part) => part.evidence.source)

		return line(
			ReportPart.Units,
			ReportLineKind.Conclusion,
			`- ${stage}: ${total.total} on ${total.at} (${sources.join(", ")})`,
			sources
		)
	}

	const values = total.conflicting.map((count) => `${count.count} per ${count.evidence.source}`).join(". ")

	return line(
		ReportPart.Units,
		total.conflicting.length ? ReportLineKind.Conclusion : ReportLineKind.Absence,
		`- ${stage}: unresolved — ${total.reason}${values ? ` (${values})` : ""}`,
		total.conflicting.map((count) => count.evidence.source)
	)
}

/**
 * A building's position.
 *
 * A resolved position and positions that differ each cite their records.
 * A building without an admitted position is an absence.
 */
function positionRecord(position: PositionAnswer): ReportLine {
	const synthetic = (flag: boolean) => (flag ? ", synthetic" : "")

	if (position.status === "resolved") {
		const sources = distinctSources(position.positions.map((entry) => entry.evidence.source))

		return line(
			ReportPart.Building,
			ReportLineKind.Conclusion,
			`Position: ${position.latitude}, ${position.longitude} (${sources.join(", ")})${synthetic(position.synthetic)}`,
			sources
		)
	}

	const values = position.conflicting
		.map((entry) => `${entry.latitude}, ${entry.longitude} per ${entry.evidence.source}${synthetic(entry.synthetic)}`)
		.join(". ")

	return line(
		ReportPart.Building,
		position.conflicting.length ? ReportLineKind.Conclusion : ReportLineKind.Absence,
		`Position: unresolved — ${position.reason}${values ? ` (${values})` : ""}`,
		position.conflicting.map((entry) => entry.evidence.source)
	)
}

/**
 * Each extent with the records that place the building in it.
 */
function extentsRecord(memberships: readonly ExtentMembership[]): ReportLine {
	const sources = new Map<string, Set<SourceRecordID>>()

	for (const membership of memberships) {
		sources.set(membership.extent, (sources.get(membership.extent) ?? new Set()).add(membership.evidence.source))
	}

	const extents = [...sources].map(([extent, cited]) => `${extent} (${[...cited].join(", ")})`)

	return line(
		ReportPart.Building,
		memberships.length ? ReportLineKind.Conclusion : ReportLineKind.Absence,
		`Extents: ${extents.join(", ") || "none"}`,
		memberships.map((membership) => membership.evidence.source)
	)
}

/**
 * The building's external identifiers on the as-of date, each followed by the record that states it.
 */
function identifiersRecord(section: BuildingSection): ReportLine {
	if (!section.identifiers.length) {
		return line(ReportPart.Building, ReportLineKind.Absence, "Identifiers: application id only")
	}

	const cited = section.identifiers.map((id) => ({
		text: `${id.namespace} ${id.value}`,
		sources: id.evidence ? [id.evidence.source] : [],
	}))

	return line(
		ReportPart.Building,
		ReportLineKind.Conclusion,
		`Identifiers: ${cited.map((entry) => `${entry.text}${cite(entry.sources)}`).join(", ")}`,
		cited.flatMap((entry) => entry.sources)
	)
}

/**
 * The records that link an alias to its entities.
 */
function aliasSources(resolution: AliasResolution): SourceRecordID[] {
	switch (resolution.kind) {
		case "resolved":
			return [resolution.evidence.source]
		case "ambiguous":
			return distinctSources(resolution.candidates.map((candidate) => candidate.evidence.source))
		case "unlinked":
			return []
	}
}

/**
 * The count of the building's entrances and its aliases, each followed by the records that link it.
 */
function entrancesRecord(section: BuildingSection): ReportLine {
	const entranceSources = section.entrances.map((link) => link.evidence.source)
	const entrances = `Entrances: ${section.entrances.length}${section.entrances.length ? cite(entranceSources) : ""}`

	const aliases = section.aliases.map((alias) => {
		const sources = aliasSources(alias.resolution)

		return {
			text: `"${alias.text}" (${alias.resolution.kind})${sources.length ? cite(sources) : ""}`,
			sources,
		}
	})

	return line(
		ReportPart.Building,
		section.entrances.length || section.aliases.length ? ReportLineKind.Conclusion : ReportLineKind.Absence,
		`${entrances}. Aliases: ${aliases.map((alias) => alias.text).join(", ") || "none"}`,
		[...entranceSources, ...aliases.flatMap((alias) => alias.sources)]
	)
}

function eventRecord(event: CommercialEvent): ReportLine {
	return line(
		ReportPart.Events,
		ReportLineKind.Conclusion,
		`- ${event.kind} on ${event.date ?? "an unknown date"} (${event.parties.map((party) => party.name).join(", ")}. Scope ${event.scope.join(", ")})${cite([event.evidence.source])}`,
		[event.evidence.source]
	)
}

function permissionsRecord(permissions: readonly CommercialEvent[]): ReportLine {
	if (!permissions.length) return line(ReportPart.Access, ReportLineKind.Absence, "Permissions: none on record")

	return line(
		ReportPart.Access,
		ReportLineKind.Conclusion,
		`Permissions: ${permissions.map((event) => `${event.parties[0]?.name ?? "unnamed"} for ${event.scope.join(", ")}${cite([event.evidence.source])}`).join(". ")}`,
		permissions.map((event) => event.evidence.source)
	)
}

/**
 * The roles with known or with unknown signing authority, each followed by the record that names it.
 */
function rolesRecord(label: string, relations: readonly OrganizationRelation[], showAuthority: boolean): ReportLine {
	if (!relations.length) return line(ReportPart.Access, ReportLineKind.Absence, `${label}: none`)

	const roles = relations.map(
		(relation) =>
			`${relation.organization} (${relation.role}${showAuthority ? `, ${relation.signingAuthority}` : ""})${cite([relation.evidence.source])}`
	)

	return line(
		ReportPart.Access,
		ReportLineKind.Conclusion,
		`${label}: ${roles.join(". ")}`,
		relations.map((relation) => relation.evidence.source)
	)
}

/**
 * A provider's answer on the as-of date, followed by each availability record's dates,
 * the extent it states when it states one, and its source record.
 *
 * An unknown answer is an absence: no admitted record covers the date.
 */
function providerRecord(
	entry: { provider: string; product: string; answer: AvailabilityAnswer },
	asOf: ISODate
): ReportLine {
	const { records, status } = entry.answer

	const dated = records.map(
		(record) =>
			`from ${record.from}${record.to ? ` to ${record.to}` : ""}${record.extent ? ` over ${record.extent}` : ""} per ${record.evidence.source}`
	)

	return line(
		ReportPart.Providers,
		status === "unknown" ? ReportLineKind.Absence : ReportLineKind.Conclusion,
		`- ${entry.provider} ${entry.product}: ${status} on ${asOf}${dated.length ? ` (${dated.join(". ")})` : ""}`,
		records.map((record) => record.evidence.source)
	)
}

/**
 * A claim value as the report prints it.
 *
 * A string is quoted, so the value `unknown` never reads as the report's own word.
 * An array or an object prints each member the same way, and an object names each member.
 */
function valueText(value: unknown): string {
	if (typeof value === "string") return `"${value}"`

	if (Array.isArray(value)) return `[${value.map(valueText).join(", ")}]`

	if (value !== null && typeof value === "object") {
		const members = Object.entries(value).map(([key, member]) => `${key}: ${valueText(member)}`)

		return members.length ? `{ ${members.join(", ")} }` : "{}"
	}

	return String(value)
}

/**
 * The date of a claim's evidence: the claim's own observation date,
 * else its source record's, else `undated`.
 */
function claimDate(claim: Claim, sources: ReadonlyMap<SourceRecordID, SourceRecord>): string {
	return claim.evidence.observedAt ?? sources.get(claim.evidence.source)?.observedAt ?? "undated"
}

/**
 * The lines for one claim: the claim itself, then the claims a derived or inferred
 * claim derives from, then an inferred claim's explanation.
 *
 * The claim's record states its derivation and explanation, so those lines rest on it too.
 */
function claimRecords(claim: Claim, sources: ReadonlyMap<SourceRecordID, SourceRecord>): ReportLine[] {
	const part = ReportPart.Claims
	const cited = [claim.evidence.source]

	const lines = [
		line(
			part,
			ReportLineKind.Conclusion,
			`- ${claim.id} — ${claim.axis} ${claim.predicate}: ${valueText(claim.value)} (${claim.status}, ${claim.evidence.source}, ${claimDate(claim, sources)})`,
			cited
		),
	]

	if (claim.status === "derived" || claim.status === "inferred") {
		lines.push(line(part, ReportLineKind.Derivation, `  - derives from: ${claim.derivedFrom.join(", ")}`, cited))
	}

	if (claim.status === "inferred") {
		lines.push(line(part, ReportLineKind.Derivation, `  - explanation: ${claim.explanation}`, cited))
	}

	return lines
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

/**
 * The lines for one unresolved question: the question, its candidates, and the record that would resolve it.
 *
 * The question and its candidates rest on the records the question cites.
 */
function unresolvedRecords(item: Unresolved): ReportLine[] {
	const part = ReportPart.Unresolved
	const lines = [line(part, ReportLineKind.Question, `- ${item.question}`, item.sources)]

	if (item.candidates.length) {
		lines.push(line(part, ReportLineKind.Question, `  - candidates: ${item.candidates.join(". ")}`, item.sources))
	}

	lines.push(line(part, ReportLineKind.Guidance, `  - would resolve: ${item.missingRecord}`))

	return lines
}

function sectionRecords(
	section: BuildingSection,
	asOf: ISODate,
	sources: ReadonlyMap<SourceRecordID, SourceRecord>
): ReportLine[] {
	const lines: ReportLine[] = [
		heading(ReportPart.Building, `## ${section.building.label}`),
		blank(ReportPart.Building),
		identifiersRecord(section),
		entrancesRecord(section),
		positionRecord(section.position),
		extentsRecord(section.memberships),
		blank(ReportPart.Building),

		heading(ReportPart.Units, "### Units"),
		blank(ReportPart.Units),
		...Object.entries(section.counts).map(([stage, total]) => totalRecord(stage, total)),
		blank(ReportPart.Units),

		heading(ReportPart.Events, "### Events"),
		blank(ReportPart.Events),
		...section.events.map(eventRecord),
		blank(ReportPart.Events),

		heading(ReportPart.Access, "### Access"),
		blank(ReportPart.Access),
		permissionsRecord(section.permissions),
		rolesRecord("Roles with known signing authority", section.authority.known, true),
		rolesRecord("Roles with unknown signing authority", section.authority.unknown, false),
		blank(ReportPart.Access),

		heading(ReportPart.Construction, "### Construction"),
		blank(ReportPart.Construction),
		...section.windows.map((window) =>
			line(
				ReportPart.Construction,
				ReportLineKind.Conclusion,
				`- ${window.stage}: ${window.start ?? "unknown start"} to ${window.end ?? "no end stated"} (${window.evidence.source})`,
				[window.evidence.source]
			)
		),
		blank(ReportPart.Construction),

		heading(ReportPart.Providers, "### Providers"),
		blank(ReportPart.Providers),
		...section.availability.map((entry) => providerRecord(entry, asOf)),
		blank(ReportPart.Providers),

		heading(ReportPart.Readings, "### Layer readings"),
		blank(ReportPart.Readings),
		...section.readings.map((reading) =>
			line(
				ReportPart.Readings,
				ReportLineKind.Conclusion,
				`${readingLine(reading)}${cite(reading.sources)}`,
				reading.sources
			)
		),
		blank(ReportPart.Readings),

		heading(ReportPart.Claims, "### Claims"),
		blank(ReportPart.Claims),
		...section.claims.flatMap((claim) => claimRecords(claim, sources)),
		blank(ReportPart.Claims),

		heading(ReportPart.Unresolved, "### Unresolved"),
		blank(ReportPart.Unresolved),
		...section.unresolved.flatMap(unresolvedRecords),
		blank(ReportPart.Unresolved),
	]

	if (section.checks.length) {
		lines.push(
			heading(ReportPart.Checks, "### Serviceability checks"),
			blank(ReportPart.Checks),
			...section.checks.flatMap((result) => checkRecords(result, asOf))
		)
	}

	return lines.map((entry) => ({ ...entry, building: section.building.id }))
}

/**
 * One list of the records header: its records, or an absence when it has none.
 */
function ledgerRecord(text: string, ids: readonly SourceRecordID[]): ReportLine {
	return line(ReportPart.Records, ids.length ? ReportLineKind.Source : ReportLineKind.Absence, text, ids)
}

/**
 * An admitted source record's identifier, publisher, title, URL and three dates.
 *
 * A missing date prints as the word `undated`.
 */
function sourceText(source: SourceRecord): string {
	const dated = (date: ISODate | null | undefined) => date ?? "undated"
	const url = source.url ? `, ${source.url}` : ""

	return `- ${source.id}: ${source.publisher}, "${source.title}"${url} (observed ${dated(source.observedAt)}, available ${dated(source.availableAt)}, retrieved ${dated(source.retrievedAt)})`
}

/**
 * The report as line records, in the order `renderReport` prints them.
 */
export function reportLines(dossier: Dossier): readonly ReportLine[] {
	const sources = new Map(dossier.admittedSources.map((source) => [source.id, source]))
	const excluded = dossier.excluded.map((record) => record.id)

	const lines: ReportLine[] = [
		heading(ReportPart.Title, `# Building dossier as of ${dossier.asOf}`),
		blank(ReportPart.Title),
		heading(ReportPart.Records, "## Records"),
		blank(ReportPart.Records),
		ledgerRecord(`Admitted (${dossier.admitted.length}): ${dossier.admitted.join(", ") || "none"}`, dossier.admitted),
		ledgerRecord(
			`Excluded, available after the cutoff (${dossier.excluded.length}): ${dossier.excluded.map((record) => `${record.id} (available ${record.availableAt})`).join(", ") || "none"}`,
			excluded
		),
		ledgerRecord(
			`Undated, no availability date (${dossier.undated.length}): ${dossier.undated.join(", ") || "none"}`,
			dossier.undated
		),
		blank(ReportPart.Records),
		...dossier.buildings.flatMap((section) => sectionRecords(section, dossier.asOf, sources)),
		heading(ReportPart.Unplaced, "## Unplaced layer readings"),
		blank(ReportPart.Unplaced),
	]

	if (dossier.unplaced.length) {
		lines.push(
			line(
				ReportPart.Unplaced,
				ReportLineKind.Absence,
				"Neither a subject nor an admitted membership places these readings at a building, so no building's section shows them."
			),
			blank(ReportPart.Unplaced)
		)

		for (const reading of dossier.unplaced) {
			lines.push(
				line(
					ReportPart.Unplaced,
					ReportLineKind.Conclusion,
					`${readingLine(reading)}${cite(reading.sources)}`,
					reading.sources
				),
				line(
					ReportPart.Unplaced,
					ReportLineKind.Guidance,
					`  - would resolve: a record that places a building in ${reading.extent}`
				)
			)
		}

		lines.push(blank(ReportPart.Unplaced))
	} else {
		lines.push(
			line(ReportPart.Unplaced, ReportLineKind.Absence, "Every admitted reading attaches to a building."),
			blank(ReportPart.Unplaced)
		)
	}

	if (dossier.buildings.some((section) => section.checks.length)) {
		lines.push(
			heading(ReportPart.Outcomes, "## Operator outcomes"),
			blank(ReportPart.Outcomes),
			...outcomeStatements(dossier.outcomes).map((entry) => statementRecord(ReportPart.Outcomes, entry)),
			blank(ReportPart.Outcomes)
		)
	}

	lines.push(heading(ReportPart.Sources, "## Sources"), blank(ReportPart.Sources))

	if (!dossier.admittedSources.length) {
		lines.push(line(ReportPart.Sources, ReportLineKind.Absence, "No source record is admitted."))
	}

	lines.push(
		...dossier.admittedSources.map((source) =>
			line(ReportPart.Sources, ReportLineKind.Source, sourceText(source), [source.id])
		),
		blank(ReportPart.Sources)
	)

	return lines
}

/**
 * The report as Markdown: the text of each of its line records, one per line.
 */
export function renderReport(dossier: Dossier): string {
	return reportLines(dossier)
		.map((entry) => entry.text)
		.join("\n")
}
