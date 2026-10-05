/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The as-of projection. Records are admitted by their availability date, so a dossier for a 2022
 *   decision contains what a reader could have known in 2022. Each building section assembles the
 *   admitted identity, count, event, authority, window, availability and reading evidence, and lists each
 *   unresolved question beside the record that would resolve it.
 */

import { availabilityAt, type AvailabilityAnswer } from "#availability"
import { type Claim, claimsFor } from "#claims"
import { totalUnits, type UnitStage, type UnitTotal } from "#counts"
import { classifyReadings, type LayerReadingClass } from "#coverage"
import type { Building } from "#entities"
import {
	type CommercialEvent,
	type ConstructionWindow,
	type OrganizationRelation,
	permissionCovers,
	signingAuthorityFor,
} from "#events"
import type { EntityID } from "#identifiers"
import { type AliasResolution, type Containment, entrancesOf, resolveAlias } from "#links"
import type { SourceRecordID } from "#sources"
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
}

export interface BuildingSection {
	building: Building
	entrances: readonly Containment[]
	aliases: readonly { text: string; resolution: AliasResolution }[]
	counts: Record<UnitStage, UnitTotal>
	events: readonly CommercialEvent[]
	permissions: readonly CommercialEvent[]
	authority: ReturnType<typeof signingAuthorityFor>
	windows: readonly ConstructionWindow[]
	availability: readonly { provider: string; product: string; answer: AvailabilityAnswer }[]
	readings: readonly { layer: string; extent: string; surveyedAt?: ISODate; class: LayerReadingClass }[]
	claims: readonly Claim[]
	unresolved: readonly Unresolved[]
}

export interface Dossier {
	asOf: ISODate
	admitted: readonly SourceRecordID[]
	excluded: readonly { id: SourceRecordID; availableAt: ISODate; observedAt?: ISODate }[]
	undated: readonly SourceRecordID[]
	buildings: readonly BuildingSection[]
	unresolved: readonly Unresolved[]
	issues: readonly ValidationIssue[]
}

const STAGES: readonly UnitStage[] = ["planned", "completed", "occupied"]

export function buildDossier(records: DossierRecords, options: { asOf: ISODate }): Dossier {
	const issues = validateRecords(records)
	const errors = issues.filter((issue) => issue.severity === "error")

	if (errors.length)
		throw new Error(`buildDossier: ${errors.map((issue) => `${issue.code}: ${issue.message}`).join(". ")}`)

	const admitted: SourceRecordID[] = []
	const excluded: { id: SourceRecordID; availableAt: ISODate; observedAt?: ISODate }[] = []
	const undated: SourceRecordID[] = []

	for (const source of records.sources) {
		const admission = admitsAsOf(source, options.asOf)

		if (admission === "admitted") {
			admitted.push(source.id)
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
	const claims = admittedOnly(records.claims)
	const aliases = records.aliases.map((alias) => ({ ...alias, candidates: admittedOnly(alias.candidates) }))

	const buildings = records.entities.filter((entity): entity is Building => entity.kind === "building")

	const sections = buildings.map((building) =>
		sectionFor(building, options.asOf, {
			containment,
			counts,
			events,
			relations,
			windows,
			availability,
			readings,
			claims,
			aliases,
		})
	)

	return {
		asOf: options.asOf,
		admitted,
		excluded,
		undated,
		buildings: sections,
		unresolved: sections.flatMap((section) => section.unresolved),
		issues,
	}
}

interface Admitted {
	containment: readonly Containment[]
	counts: DossierRecords["counts"]
	events: readonly CommercialEvent[]
	relations: readonly OrganizationRelation[]
	windows: readonly ConstructionWindow[]
	availability: DossierRecords["availability"]
	readings: DossierRecords["readings"]
	claims: readonly Claim[]
	aliases: DossierRecords["aliases"]
}

function sectionFor(building: Building, asOf: ISODate, admitted: Admitted): BuildingSection {
	const unresolved: Unresolved[] = []
	const entrances = entrancesOf(building.id, admitted.containment)
	const mine = new Set<EntityID>([building.id, ...entrances.map((link) => link.child)])

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
				})
			}

			return { text: alias.text, resolution }
		})

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
			})
		}

		return { provider, product, answer }
	})

	const byLayer = new Map<string, DossierRecords["readings"]>()

	for (const reading of admitted.readings) {
		// A subject-scoped reading attaches to its building alone.
		// An unscoped reading keeps the every-building association that #2289's spatial key will replace.
		if (reading.subject !== undefined && reading.subject !== building.id) continue

		// A vintage is part of a survey's identity.
		// Two vintages of one layer and extent group separately.
		const key = `${reading.layer}${reading.extent}${reading.surveyedAt ?? ""}`

		byLayer.set(key, [...(byLayer.get(key) ?? []), reading])
	}

	const readings = [...byLayer.values()].map((group) => {
		const classified = classifyReadings(group)
		const [first] = group

		if (classified.class !== "records" && classified.class !== "surveyed_empty") {
			unresolved.push({
				question: `What does the ${first!.layer} layer hold for ${first!.extent}${first!.surveyedAt ? ` as of ${first!.surveyedAt}` : ""}?`,
				subject: building.id,
				candidates: group.map((reading) => `${reading.records ?? "no survey"} (${reading.evidence.source})`),
				missingRecord: `a surveyed or designated reading of ${first!.layer} over ${first!.extent}`,
			})
		}

		return { layer: first!.layer, extent: first!.extent, surveyedAt: first!.surveyedAt, class: classified.class }
	})

	return {
		building,
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
	}
}
