/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Dossier records from a `flood.db` answer at a building's coordinate. The reading keeps the
 *   layer's three answers apart. A designated zone is one record. A designated absence is zero records
 *   on the coverage row's basis. A location outside the footprint has no survey.
 *
 *   A layer reading has no field for a zone code, so each determined answer also yields a designated
 *   claim with the code as its value. A designated absence yields the Zone 1 claim. Its code is the
 *   code of the definition the lookup returns for the absence. An unknown answer yields no claim. A
 *   building without a flood-zone claim therefore has an unknown reading, and never an unclaimed Zone 1.
 *
 *   The claim's value is the zone the authority's map assigns at the coordinate. That value is a fact
 *   about the map. It makes no statement about the building's flood risk, and a Zone 1 claim is silent
 *   about surface water, groundwater and defended-area residual risk.
 */

import type { Claim, EntityID, LayerReading, SourceRecordID } from "@mailwoman/dossier"

import { FloodReadingKind, type FloodZoneLookup, type FloodZoneReading } from "#index"

/**
 * The building and coordinate {@link floodLayerReading} reads.
 */
export interface FloodLayerReadingQuery {
	/**
	 * The building the reading belongs to.
	 */
	subject: EntityID
	/**
	 * The building's coordinate.
	 *
	 * The caller supplies it because a dossier building holds none.
	 */
	latitude: number
	longitude: number
	/**
	 * The source record for the flood map the database was built from.
	 */
	source: SourceRecordID
}

/**
 * One flood answer as dossier records.
 */
export interface FloodDossierRecords {
	reading: LayerReading
	/**
	 * The zone the authority's map assigns at the coordinate, absent when the reading is unknown.
	 */
	claim?: Claim<string>
}

/**
 * Read a building's coordinate as one dossier layer reading and, for a determined
 * answer, a designated `flood_zone` claim.
 *
 * The reading's layer and `surveyedAt` are the manifest's name and source vintage, and its
 * extent is `point:<latitude>,<longitude>`, because the answer holds for that coordinate.
 * `records` is 1 for a designated zone, 0 for a designated absence and `null` for an unknown answer.
 *
 * `basis` is the basis the coverage row stores, or `null` when the answer has no coverage row.
 */
export function floodLayerReading(lookup: FloodZoneLookup, query: FloodLayerReadingQuery): FloodDossierRecords {
	const answer = lookup.lookup(query.latitude, query.longitude)
	const { name: layer, sourceVintage: surveyedAt } = lookup.identity.manifest
	const evidence = { source: query.source }

	const reading = (basis: LayerReading["basis"], records: number | null): LayerReading => ({
		layer,
		extent: `point:${query.latitude},${query.longitude}`,
		subject: query.subject,
		basis,
		surveyedAt,
		records,
		evidence,
	})

	if (answer.kind === FloodReadingKind.Unknown) return { reading: reading(null, null) }

	const zoneCode = answer.zoneCode ?? answer.definition?.code

	if (zoneCode == null) {
		throw new Error(
			`floodLayerReading: the ${answer.kind} answer at ${query.latitude}, ${query.longitude} has no zone code`
		)
	}

	const claim: Claim<string> = {
		id: `${layer}:${query.subject}:${surveyedAt}`,
		subject: query.subject,
		axis: "premises",
		predicate: "flood_zone",
		value: zoneCode,
		status: "designated",
		evidence,
	}

	if (answer.kind === FloodReadingKind.DesignatedAbsence) {
		if (!answer.coverage) {
			throw new Error(
				`floodLayerReading: the designated absence at ${query.latitude}, ${query.longitude} has no coverage row`
			)
		}

		return { reading: reading(storedBasis(answer.coverage), 0), claim }
	}

	return { reading: reading(answer.coverage ? storedBasis(answer.coverage) : null, 1), claim }
}

/**
 * The basis a coverage row stores.
 */
function storedBasis(coverage: NonNullable<FloodZoneReading["coverage"]>): LayerReading["basis"] {
	if (coverage.basis == null) {
		throw new Error(`floodLayerReading: the coverage row for ${coverage.h3CellIndex} has no basis`)
	}

	return coverage.basis
}
