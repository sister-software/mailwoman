/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The building scale of the map: one GeoJSON feature per dossier building, in one of five states. Each
 *   state is decided by a stated rule over the building's unit total at a stage the caller chooses, its
 *   providers' availability on the dossier date, and its availability checks. The rules apply in this
 *   order, and the first that matches decides the state:
 *
 *   1. `unknown_unit_count`: the unit total is unresolved.
 *   2. `zero_premises`: the unit total resolves to 0.
 *   3. `partial_availability`: a provider is recorded as available on the dossier date, or the latest
 *      readings of one of the building's checks hold records. A dossier records availability for a
 *      building or its extent, and no record establishes service to every unit, so no state claims a
 *      fully served building. For a record that states an extent, the reason says the provider is
 *      recorded as available over that extent, because such a record does not say which premises in
 *      the extent are served.
 *   4. `known_unserved`: the building has a check, the latest readings of every check establish absence,
 *      and no provider is recorded as available.
 *   5. `unknown_coverage`: every other building.
 *
 *   A feature carries its unit denominator, a number or the word `unresolved`, and the source records
 *   behind its state. Its units, service evidence and access records are separate groups, and it carries
 *   no economic figure: economics belong to a selection of buildings. Its geometry is a point at the
 *   building's resolved position, or `null` when the position is unresolved.
 */

import {
	availabilityAt,
	type BuildingSection,
	type Dossier,
	type EntityID,
	type ISODate,
	LayerReadingClass,
	type PositionAnswer,
	type SourceRecordID,
	type UnitStage,
} from "@mailwoman/dossier"
import type { GeoFeature, GeoFeatureCollection, PointLiteral } from "@mailwoman/spatial"

/**
 * The five states of a building on the map, as wire values.
 */
export const BuildingState = {
	UnknownUnitCount: "unknown_unit_count",
	ZeroPremises: "zero_premises",
	PartialAvailability: "partial_availability",
	KnownUnserved: "known_unserved",
	UnknownCoverage: "unknown_coverage",
} as const

export type BuildingState = (typeof BuildingState)[keyof typeof BuildingState]

/**
 * A building's unit total at one stage: a resolved number, or the word
 * `unresolved` with the dossier's reason.
 *
 * `sources` holds the records of the counts that make the total, or of the counts that conflict.
 */
export type UnitDenominator =
	| { stage: UnitStage; at: ISODate; total: number; sources: readonly SourceRecordID[] }
	| { stage: UnitStage; at: ISODate; total: "unresolved"; reason: string; sources: readonly SourceRecordID[] }

/**
 * The records that bear on service at a building.
 */
export interface ServiceEvidence {
	/**
	 * Each provider recorded as available at the building on the dossier date, once for
	 * each extent at which the records current on that date state the availability.
	 *
	 * An entry without an `extent` rests on records that state availability for the building itself.
	 * An entry with one rests on records whose source states availability over that extent, such as
	 * `census-block:<GEOID>`, and those records do not say which premises in the extent are served.
	 */
	available: readonly { provider: string; product: string; extent?: string; sources: readonly SourceRecordID[] }[]
	/**
	 * Each of the building's availability checks, with the class of its latest readings.
	 */
	checks: readonly {
		check: string
		layer: string
		extent: string
		status: LayerReadingClass
		vintage?: ISODate
		sources: readonly SourceRecordID[]
	}[]
}

/**
 * The access records of a building.
 */
export interface AccessEvidence {
	/**
	 * The landlord permissions that cover the building or one of its entrances, by event identifier.
	 */
	permissions: readonly string[]
	/**
	 * Each organization's role at the building, with its signing authority.
	 */
	roles: readonly { organization: string; role: string; signingAuthority: "yes" | "no" | "unknown" }[]
}

/**
 * Where a building stands, as its feature states it beside the geometry.
 *
 * An unresolved position lists every position that differs, and none when no position is admitted.
 */
export type FeaturePosition =
	| { status: "resolved"; synthetic: boolean; sources: readonly SourceRecordID[] }
	| {
			status: "unresolved"
			reason: string
			candidates: readonly { latitude: number; longitude: number; synthetic: boolean; source: SourceRecordID }[]
	  }

export interface BuildingProperties {
	building: EntityID
	label: string
	state: BuildingState
	/**
	 * The rule that decided the state, applied to the building's values.
	 */
	reason: string
	units: UnitDenominator
	service: ServiceEvidence
	access: AccessEvidence
	position: FeaturePosition
	/**
	 * The source records behind the state: the unit total's, then those of the service evidence the rule read.
	 */
	sources: readonly SourceRecordID[]
}

export type BuildingFeature = GeoFeature<PointLiteral | null, BuildingProperties>

export type BuildingCollection = GeoFeatureCollection<PointLiteral | null, BuildingProperties>

export interface BuildingOptions {
	/**
	 * The unit stage whose total is each building's denominator.
	 */
	unitStage: UnitStage
}

/**
 * Joins words as English prose without a serial comma: `a, b and c`.
 */
const PROSE_LIST = new Intl.ListFormat("en-GB", { style: "long", type: "conjunction" })

function distinct(sources: Iterable<SourceRecordID>): SourceRecordID[] {
	return [...new Set(sources)]
}

function unitDenominator(section: BuildingSection, stage: UnitStage): UnitDenominator {
	const total = section.counts[stage]

	if (total.status === "resolved") {
		return {
			stage,
			at: total.at,
			total: total.total,
			sources: distinct(total.parts.map((part) => part.evidence.source)),
		}
	}

	return {
		stage,
		at: total.at,
		total: "unresolved",
		reason: total.reason,
		sources: distinct(total.conflicting.map((count) => count.evidence.source)),
	}
}

/**
 * Each available provider's records current on the dossier date, grouped by the extent each record states.
 *
 * `availabilityAt` decides currency over one record at a time, so the grouping uses the dossier's own rule.
 */
function availableEvidence(section: BuildingSection, asOf: ISODate): ServiceEvidence["available"] {
	return section.availability
		.filter((entry) => entry.answer.status === "available")
		.flatMap((entry) => {
			const byExtent = new Map<string | undefined, SourceRecordID[]>()

			for (const record of entry.answer.records) {
				if (availabilityAt([record], record.provider, record.subject, asOf).status !== "available") continue

				byExtent.set(record.extent, [...(byExtent.get(record.extent) ?? []), record.evidence.source])
			}

			return [...byExtent].map(([extent, sources]) => ({
				provider: entry.provider,
				product: entry.product,
				...(extent === undefined ? {} : { extent }),
				sources: distinct(sources),
			}))
		})
}

function serviceEvidence(section: BuildingSection, asOf: ISODate): ServiceEvidence {
	return {
		available: availableEvidence(section, asOf),
		checks: section.checks.map((result) => ({
			check: result.check.id,
			layer: result.check.layer,
			extent: result.check.extent,
			status: result.status,
			vintage: result.vintage,
			sources: distinct(result.answer.flatMap((statement) => statement.sources)),
		})),
	}
}

function featurePosition(position: PositionAnswer): FeaturePosition {
	if (position.status === "resolved") {
		return {
			status: "resolved",
			synthetic: position.synthetic,
			sources: distinct(position.positions.map((entry) => entry.evidence.source)),
		}
	}

	return {
		status: "unresolved",
		reason: position.reason,
		candidates: position.conflicting.map((entry) => ({
			latitude: entry.latitude,
			longitude: entry.longitude,
			synthetic: entry.synthetic,
			source: entry.evidence.source,
		})),
	}
}

/**
 * The state of one building, with the reason and the source records behind it.
 */
function stateOf(
	units: UnitDenominator,
	service: ServiceEvidence,
	asOf: ISODate
): Pick<BuildingProperties, "state" | "reason" | "sources"> {
	if (units.total === "unresolved") {
		return {
			state: BuildingState.UnknownUnitCount,
			reason: `The ${units.stage} unit total is unresolved: ${units.reason}.`,
			sources: units.sources,
		}
	}

	if (units.total === 0) {
		return {
			state: BuildingState.ZeroPremises,
			reason: `The ${units.stage} unit total is 0 on ${units.at}.`,
			sources: units.sources,
		}
	}

	const serving = service.checks.filter((check) => check.status === LayerReadingClass.Records)

	if (service.available.length || serving.length) {
		const recorded = [
			...service.available.map(
				(entry) =>
					`${entry.provider} ${entry.product} is recorded as available${entry.extent ? ` over ${entry.extent}` : ""}`
			),
			...serving.map((check) => `the latest readings of check ${check.check} hold records`),
		]

		return {
			state: BuildingState.PartialAvailability,
			reason: `On ${asOf}, ${PROSE_LIST.format(recorded)}. No admitted record establishes service to all ${units.total} ${units.stage} units.`,
			sources: distinct([
				...units.sources,
				...service.available.flatMap((entry) => entry.sources),
				...serving.flatMap((check) => check.sources),
			]),
		}
	}

	const checked = distinct([...units.sources, ...service.checks.flatMap((check) => check.sources)])

	if (service.checks.length && service.checks.every((check) => check.status === LayerReadingClass.SurveyedEmpty)) {
		return {
			state: BuildingState.KnownUnserved,
			reason: `On ${asOf}, the latest readings of ${PROSE_LIST.format(service.checks.map((check) => `check ${check.check}`))} establish absence, and no provider is recorded as available.`,
			sources: checked,
		}
	}

	if (!service.checks.length) {
		return {
			state: BuildingState.UnknownCoverage,
			reason: `On ${asOf}, no provider is recorded as available, and the building has no check.`,
			sources: checked,
		}
	}

	return {
		state: BuildingState.UnknownCoverage,
		reason: `On ${asOf}, no provider is recorded as available. The latest readings are ${PROSE_LIST.format(service.checks.map((check) => `${check.status} for check ${check.check}`))}, so service at the building is unknown.`,
		sources: checked,
	}
}

/**
 * The map properties of one dossier building section on the dossier date `asOf`.
 */
export function buildingProperties(
	section: BuildingSection,
	options: BuildingOptions & { asOf: ISODate }
): BuildingProperties {
	const units = unitDenominator(section, options.unitStage)
	const service = serviceEvidence(section, options.asOf)
	const { state, reason, sources } = stateOf(units, service, options.asOf)

	return {
		building: section.building.id,
		label: section.building.label,
		state,
		reason,
		units,
		service,
		access: {
			permissions: section.permissions.map((event) => event.id),
			roles: [...section.authority.known, ...section.authority.unknown].map((relation) => ({
				organization: relation.organization,
				role: relation.role,
				signingAuthority: relation.signingAuthority,
			})),
		},
		position: featurePosition(section.position),
		sources,
	}
}

/**
 * The building scale of the map: one feature per dossier building, in the dossier's building order.
 */
export function buildingFeatures(dossier: Dossier, options: BuildingOptions): BuildingCollection {
	return {
		type: "FeatureCollection",
		features: dossier.buildings.map((section): BuildingFeature => ({
			type: "Feature",
			geometry:
				section.position.status === "resolved"
					? { type: "Point", coordinates: [section.position.longitude, section.position.latitude] }
					: null,
			properties: buildingProperties(section, { ...options, asOf: dossier.asOf }),
		})),
	}
}
