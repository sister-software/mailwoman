/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The as-of projection. Records are admitted by their availability date, so a dossier for a 2022
 *   decision contains what a reader could have known in 2022. Each building section assembles the
 *   admitted identity, position, membership, claim, count, event, authority, window, availability and
 *   reading evidence, and lists each unresolved question beside the record that would resolve it. A
 *   building's availability checks are answered and explained from the same admitted records.
 *
 *   An external identifier is admitted by its evidence like every other record. An identifier without
 *   evidence stays in the section, and the report prints it with the words `source unstated`.
 *
 *   A derived or inferred claim is admitted only when every claim it derives from is admitted.
 *
 *   A layer reading attaches by its subject, then by an admitted membership, and otherwise to no
 *   building. The dossier lists a reading that neither rule places as unplaced, and no section shows it.
 */

import { availabilityAt, type AvailabilityAnswer } from "#availability"
import { admittedClaims, type Claim, claimsFor } from "#claims"
import { totalUnits, type UnitStage, type UnitTotal } from "#counts"
import { classifyReadings, type LayerReading, type LayerReadingClass } from "#coverage"
import type { Building } from "#entities"
import {
	type CommercialEvent,
	type ConstructionWindow,
	type OrganizationRelation,
	permissionCovers,
	signingAuthorityFor,
} from "#events"
import {
	type AvailabilityCheck,
	type BlockerObservation,
	type CheckResult,
	explainCheck,
	type ExplanationProbability,
	type OperatorDisposition,
} from "#explanations"
import type { EntityID, ExternalID } from "#identifiers"
import { type AliasResolution, type Containment, entrancesOf, resolveAlias } from "#links"
import { type OutcomeReport, reportOutcomes } from "#outcomes"
import {
	type BuildingPosition,
	type ExtentMembership,
	positionOf,
	type PositionAnswer,
	readingBuildings,
} from "#placement"
import type { SourceRecord, SourceRecordID } from "#sources"
import { admitsAsOf, type ISODate } from "#time"
import { type DossierRecords, validateRecords, type ValidationIssue } from "#validate"

export interface Unresolved {
	question: string
	subject?: EntityID
	candidates: readonly string[]
	/**
	 * The record that would resolve the question, in words a reader can act on.
	 */
	missingRecord: string
	/**
	 * The admitted records the question rests on.
	 *
	 * They are the records of its candidates, or the record that raises the question.
	 * The list is empty when no admitted record bears on the question.
	 */
	sources: readonly SourceRecordID[]
}

export interface BuildingSection {
	building: Building
	/**
	 * The building's external identifiers on the as-of date.
	 *
	 * An identifier whose evidence the dossier admits is listed with that evidence.
	 * An identifier without evidence is listed as supplied.
	 *
	 * An identifier whose evidence is excluded or undated is left out, as an alias is.
	 */
	identifiers: readonly ExternalID[]
	entrances: readonly Containment[]
	aliases: readonly { text: string; resolution: AliasResolution }[]
	counts: Record<UnitStage, UnitTotal>
	events: readonly CommercialEvent[]
	permissions: readonly CommercialEvent[]
	authority: ReturnType<typeof signingAuthorityFor>
	windows: readonly ConstructionWindow[]
	availability: readonly { provider: string; product: string; answer: AvailabilityAnswer }[]
	/**
	 * The admitted readings of the building, grouped by layer, extent and survey date.
	 *
	 * Each group lists the admitted source records of its readings, as an unplaced reading does.
	 */
	readings: readonly {
		layer: string
		extent: string
		surveyedAt?: ISODate
		class: LayerReadingClass
		sources: readonly SourceRecordID[]
	}[]
	claims: readonly Claim[]
	unresolved: readonly Unresolved[]
	/**
	 * The building's availability checks, each answered and, when it fails, explained.
	 */
	checks: readonly CheckResult[]
	/**
	 * The admitted memberships that place the building in an extent.
	 *
	 * A reading without a subject attaches to the building through one of them.
	 */
	memberships: readonly ExtentMembership[]
	/**
	 * The building's location on the as-of date, from its admitted positions.
	 */
	position: PositionAnswer
}

/**
 * Admitted readings of one layer, extent and survey date that neither a subject
 * nor an admitted membership places at a building.
 */
export interface UnplacedReading {
	layer: string
	extent: string
	surveyedAt?: ISODate
	class: LayerReadingClass
	sources: readonly SourceRecordID[]
}

export interface Dossier {
	asOf: ISODate
	admitted: readonly SourceRecordID[]
	/**
	 * The admitted source records, in the order of {@link Dossier.admitted}.
	 *
	 * The report dates each claim from its evidence or from these records.
	 */
	admittedSources: readonly SourceRecord[]
	excluded: readonly { id: SourceRecordID; availableAt: ISODate; observedAt?: ISODate }[]
	undated: readonly SourceRecordID[]
	buildings: readonly BuildingSection[]
	unresolved: readonly Unresolved[]
	issues: readonly ValidationIssue[]
	/**
	 * Blocker accuracy and time saved over the admitted operator dispositions.
	 */
	outcomes: OutcomeReport
	/**
	 * The admitted readings that attach to no building.
	 * No building's section shows them.
	 */
	unplaced: readonly UnplacedReading[]
}

interface ReadingGroup {
	layer: string
	extent: string
	surveyedAt?: ISODate
	class: LayerReadingClass
	readings: readonly LayerReading[]
}

/**
 * Groups readings by layer, extent and survey date, in the order of each group's
 * first reading, and classifies each group.
 */
function readingGroups(readings: readonly LayerReading[]): ReadingGroup[] {
	const groups = new Map<string, LayerReading[]>()

	for (const reading of readings) {
		// A vintage is part of a survey's identity.
		// Two vintages of one layer and extent group separately.
		const key = `${reading.layer}\u0001${reading.extent}\u0001${reading.surveyedAt ?? ""}`

		groups.set(key, [...(groups.get(key) ?? []), reading])
	}

	return [...groups.values()].map((group) => {
		const [first] = group

		return {
			layer: first!.layer,
			extent: first!.extent,
			surveyedAt: first!.surveyedAt,
			class: classifyReadings(group).class,
			readings: group,
		}
	})
}

const STAGES: readonly UnitStage[] = ["planned", "completed", "occupied"]

export function buildDossier(records: DossierRecords, options: { asOf: ISODate }): Dossier {
	const issues = validateRecords(records)
	const errors = issues.filter((issue) => issue.severity === "error")

	if (errors.length)
		throw new Error(`buildDossier: ${errors.map((issue) => `${issue.code}: ${issue.message}`).join(". ")}`)

	const admitted: SourceRecordID[] = []
	const admittedSources: SourceRecord[] = []
	const excluded: { id: SourceRecordID; availableAt: ISODate; observedAt?: ISODate }[] = []
	const undated: SourceRecordID[] = []

	for (const source of records.sources) {
		const admission = admitsAsOf(source, options.asOf)

		if (admission === "admitted") {
			admitted.push(source.id)
			admittedSources.push(source)
		} else if (admission === "excluded") {
			excluded.push({ id: source.id, availableAt: source.availableAt!, observedAt: source.observedAt })
		} else {
			undated.push(source.id)
		}
	}

	const admittedSet = new Set(admitted)

	const admittedOnly = <T extends { evidence: { source: SourceRecordID } }>(items: readonly T[]): readonly T[] =>
		items.filter((item) => admittedSet.has(item.evidence.source))

	const containment = admittedOnly(records.containment)
	const counts = admittedOnly(records.counts)
	const events = admittedOnly(records.events)
	const relations = admittedOnly(records.relations)
	const windows = admittedOnly(records.windows)
	const availability = admittedOnly(records.availability)
	const readings = admittedOnly(records.readings)
	const claims = admittedClaims(records.claims, admittedSet)
	const aliases = records.aliases.map((alias) => ({ ...alias, candidates: admittedOnly(alias.candidates) }))
	const blockers = admittedOnly(records.blockers ?? [])
	const probabilities = admittedOnly(records.probabilities ?? [])
	const memberships = admittedOnly(records.memberships ?? [])
	const positions = admittedOnly(records.positions ?? [])

	// A disposition and its outcome cite separate records, so a dossier dated between
	// the two shows the decision with its outcome pending.
	const dispositions = admittedOnly(records.dispositions ?? []).map((disposition) =>
		disposition.outcome && !admittedSet.has(disposition.outcome.evidence.source)
			? { ...disposition, outcome: undefined }
			: disposition
	)

	const buildings = records.entities.filter((entity): entity is Building => entity.kind === "building")

	const sections = buildings.map((building) =>
		sectionFor(building, options.asOf, {
			sourceIDs: admittedSet,
			containment,
			counts,
			events,
			relations,
			windows,
			availability,
			readings,
			claims,
			aliases,
			checks: records.checks ?? [],
			blockers,
			probabilities,
			dispositions,
			memberships,
			positions,
		})
	)

	const unplaced = readingGroups(readings.filter((reading) => !readingBuildings(reading, memberships).length))

	return {
		asOf: options.asOf,
		admitted,
		admittedSources,
		excluded,
		undated,
		buildings: sections,
		unresolved: sections.flatMap((section) => section.unresolved),
		issues,
		outcomes: reportOutcomes(dispositions),
		unplaced: unplaced.map((group) => ({
			layer: group.layer,
			extent: group.extent,
			surveyedAt: group.surveyedAt,
			class: group.class,
			sources: [...new Set(group.readings.map((reading) => reading.evidence.source))],
		})),
	}
}

interface Admitted {
	/**
	 * The identifiers of the admitted source records.
	 */
	sourceIDs: ReadonlySet<SourceRecordID>
	containment: readonly Containment[]
	counts: DossierRecords["counts"]
	events: readonly CommercialEvent[]
	relations: readonly OrganizationRelation[]
	windows: readonly ConstructionWindow[]
	availability: DossierRecords["availability"]
	readings: DossierRecords["readings"]
	claims: readonly Claim[]
	aliases: DossierRecords["aliases"]
	/**
	 * Every supplied check.
	 * A check is a question and cites no record to admit it by.
	 */
	checks: readonly AvailabilityCheck[]
	blockers: readonly BlockerObservation[]
	probabilities: readonly ExplanationProbability[]
	dispositions: readonly OperatorDisposition[]
	memberships: readonly ExtentMembership[]
	positions: readonly BuildingPosition[]
}

/**
 * The distinct source records of `items`, in the order of their first citation.
 */
function sourcesOf(items: readonly { evidence: { source: SourceRecordID } }[]): SourceRecordID[] {
	return [...new Set(items.map((item) => item.evidence.source))]
}

function sectionFor(building: Building, asOf: ISODate, admitted: Admitted): BuildingSection {
	const unresolved: Unresolved[] = []
	const entrances = entrancesOf(building.id, admitted.containment)
	const mine = new Set<EntityID>([building.id, ...entrances.map((link) => link.child)])
	const position = positionOf(admitted.positions, { subject: building.id, asOf })

	// An identifier with evidence waits for its record, as an alias candidate does.
	const identifiers = building.externalIDs.filter(
		(id) => id.evidence === undefined || admitted.sourceIDs.has(id.evidence.source)
	)

	const aliases = admitted.aliases
		.filter((alias) => alias.candidates.some((candidate) => mine.has(candidate.entity)))
		.map((alias) => {
			const resolution = resolveAlias(alias)

			if (resolution.kind === "ambiguous") {
				unresolved.push({
					question: `Which entity does the alias "${alias.text}" refer to?`,
					subject: building.id,
					candidates: resolution.candidates.map((candidate) => candidate.entity),
					missingRecord: `a source that links "${alias.text}" to one of ${resolution.candidates.map((candidate) => candidate.entity).join(", ")}`,
					sources: sourcesOf(resolution.candidates),
				})
			}

			return { text: alias.text, resolution }
		})

	if (position.status === "unresolved") {
		unresolved.push({
			question: `Where is ${building.label}?`,
			subject: building.id,
			candidates: position.conflicting.map(
				(entry) => `${entry.latitude}, ${entry.longitude} (${entry.evidence.source})`
			),
			missingRecord: position.conflicting.length
				? `a record that settles which of the ${position.conflicting.length} positions locates ${building.label}`
				: `a dated position record for ${building.label}`,
			sources: sourcesOf(position.conflicting),
		})
	}

	const counts = Object.fromEntries(
		STAGES.map((stage) => {
			const dates = admitted.counts
				.filter((count) => count.subject === building.id && count.stage === stage)
				.map((count) => count.at)

			const latest = dates.toSorted().at(-1) ?? asOf
			const total = totalUnits(admitted.counts, { subjects: [building.id], stage, at: latest })

			if (total.status === "unresolved") {
				unresolved.push({
					question: `How many ${stage} units does ${building.label} have?`,
					subject: building.id,
					candidates: total.conflicting.map((count) => `${count.count} (${count.evidence.source})`),
					missingRecord: total.conflicting.length
						? `a record that settles ${total.reason}`
						: `a dated ${stage} unit count for ${building.label}`,
					sources: sourcesOf(total.conflicting),
				})
			}

			return [stage, total]
		})
	) as Record<UnitStage, UnitTotal>

	const events = admitted.events.filter((event) => event.scope.some((entity) => mine.has(entity)))
	const permissions = [...mine].flatMap((entity) => permissionCovers(admitted.events, entity))
	const authority = signingAuthorityFor(admitted.relations, building.id)

	for (const relation of authority.unknown) {
		unresolved.push({
			question: `Does ${relation.organization} (${relation.role}) hold signing authority for ${building.label}?`,
			subject: building.id,
			candidates: [],
			missingRecord: `a dated record naming the signatory for ${building.label}`,
			sources: [relation.evidence.source],
		})
	}

	const windows = admitted.windows.filter((window) => window.subject === building.id)

	for (const window of windows) {
		if (window.end === undefined) {
			unresolved.push({
				question: `When does the construction window that opened ${window.start ?? "on an unknown date"} (${window.stage}) close? The record states no end.`,
				subject: building.id,
				candidates: [],
				missingRecord: `a completion or occupancy record for ${building.label}`,
				sources: [window.evidence.source],
			})
		}
	}

	const providers = new Map<string, string>()

	for (const record of admitted.availability)
		if (record.subject === building.id) {
			providers.set(record.provider, record.product)
		}

	const availability = [...providers].map(([provider, product]) => {
		const answer = availabilityAt(admitted.availability, provider, building.id, asOf)

		if (answer.status === "unknown") {
			unresolved.push({
				question: `Was ${provider} available at ${building.label} on ${asOf}?`,
				subject: building.id,
				candidates: [],
				missingRecord: `a dated availability record from ${provider} covering ${asOf}`,
				sources: sourcesOf(answer.records),
			})
		}

		return { provider, product, answer }
	})

	// A reading with a subject attaches to that building and to no other.
	// A reading without one attaches to each building that an admitted membership places in its extent.
	const attached = admitted.readings.filter((reading) =>
		readingBuildings(reading, admitted.memberships).includes(building.id)
	)

	const readings = readingGroups(attached).map((group) => {
		const sources = sourcesOf(group.readings)

		if (group.class !== "records" && group.class !== "surveyed_empty") {
			unresolved.push({
				question: `What does the ${group.layer} layer hold for ${group.extent}${group.surveyedAt ? ` as of ${group.surveyedAt}` : ""}?`,
				subject: building.id,
				candidates: group.readings.map((reading) => `${reading.records ?? "no survey"} (${reading.evidence.source})`),
				missingRecord: `a surveyed or designated reading of ${group.layer} over ${group.extent}`,
				sources,
			})
		}

		return { layer: group.layer, extent: group.extent, surveyedAt: group.surveyedAt, class: group.class, sources }
	})

	const checks = admitted.checks
		.filter((check) => check.subject === building.id)
		.map((check) =>
			explainCheck(check, {
				asOf,
				building,
				entrances: entrances.map((link) => link.child),
				aliases,
				readings: admitted.readings,
				windows: admitted.windows,
				counts: admitted.counts,
				availability: admitted.availability,
				events: admitted.events,
				relations: admitted.relations,
				blockers: admitted.blockers,
				probabilities: admitted.probabilities,
				dispositions: admitted.dispositions,
				memberships: admitted.memberships,
			})
		)

	return {
		building,
		identifiers,
		entrances,
		aliases,
		counts,
		events,
		permissions,
		authority,
		windows,
		availability,
		readings,
		claims: claimsFor(building.id, admitted.claims),
		unresolved,
		checks,
		memberships: admitted.memberships.filter((membership) => membership.subject === building.id),
		position,
	}
}
