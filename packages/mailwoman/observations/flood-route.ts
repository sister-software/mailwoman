/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The authority-designation route, observation-only: after the resolver has produced a coordinate, an
 *   authority's own designation for that coordinate is recorded beside the answer — the zone the
 *   authority's map assigns, the product and version it was read from, and the coverage record stating
 *   that the authority made a determination there.
 *
 *   THE ROUTE READS; IT NEVER ANSWERS. It takes a finished coordinate and returns a record. Nothing here
 *   is consulted while an answer is being chosen, no candidate is read, no result is added, removed or
 *   re-ordered, and no abstain is reached or avoided because of it. A geocode with the route configured is
 *   the same geocode plus one advisory, which is a statement about construction rather than about a
 *   measurement.
 *
 *   PRESENCE IS THE SWITCH, AND IT IS A LAYER PATH. There is no boolean: a boolean would make the caller's
 *   factory construct the reader itself and put a sealed layer open on the default construction path. A
 *   session resolves the layer path, opens it if the file is there, and hands the route in; a session that
 *   finds no file hands in nothing and is byte-identical to one built before this route existed.
 *
 *   WHAT IT REPORTS, AND WHAT IT REFUSES TO. Three readings come out of the layer and only two of them
 *   reach a caller. A `designated` reading carries the authority's zone code. A `designated_absence`
 *   carries the authority's own definition of the absent case — for the EA product that is Flood Zone 1,
 *   which the Planning Practice Guidance defines as the land outside Zones 2 and 3, so an empty answer
 *   inside England is a designation rather than a gap. An `unknown` reading raises NOTHING: outside the
 *   authority's footprint there is no coverage row, and a marker there would be an advisory about a
 *   determination nobody made.
 *
 *   THE OBSERVATION IS ABOUT THE MAP, NEVER ABOUT THE PROPERTY. The EA states that its data is "not
 *   suitable for showing whether an individual property is at risk of flooding". So the wording reports
 *   which zone the authority's map assigns at the location — a fact about the map — and the product's own
 *   exclusions ride on every observation, because a caller cannot see from a zone code that the answer is
 *   silent about surface water, groundwater and defended-area residual risk.
 */

import {
	FloodReadingKind,
	FloodZoneLookup,
	type FloodContainmentPath,
	type FloodLayerIdentity,
	type FloodZoneReading,
} from "@mailwoman/flood"

import {
	observationCoverageRecord,
	observationLayerRecord,
	type ObservationCoverageRecord,
	type ObservationLayerRecord,
} from "./layer-record.ts"

/**
 * One authority designation, recorded beside an answer.
 *
 * Everything a reader needs to check the claim is here: which authority, which product and vintage, the code in that
 * authority's own vocabulary with the authority's own definition of it, how containment was established, and the
 * coverage record — cell, basis, completeness — that licenses an absence reading. A reader holding the code alone
 * cannot tell whether it was earned.
 */
export interface AuthorityDesignationObservation {
	/**
	 * `designated` or `designated_absence`. Never `unknown`: that reading produces no observation.
	 */
	reading: FloodReadingKind
	/**
	 * The authority's code, verbatim. Absent on a designated absence, which the authority represents by publishing
	 * nothing.
	 */
	code?: string
	/**
	 * The authority's own words for the answered code, and where they are published.
	 */
	definition?: { code: string; label: string; definition: string; definitionURL: string }
	/**
	 * The polygon the ray cast matched, where one did.
	 */
	areaID?: string
	containment: FloodContainmentPath
	/**
	 * The coverage side of the claim, present whenever the location falls inside the authority's footprint.
	 */
	coverage?: ObservationCoverageRecord
	/**
	 * The index cell probed.
	 */
	indexCellIndex: string
	/**
	 * The authority's own statement of what its map covers, and where it is published.
	 */
	extent: { authority: string; statement: string; statementURL: string }
	/**
	 * What the product excludes, in the authority's own words.
	 */
	limits: ReadonlyArray<string>
	layer: ObservationLayerRecord
	databasePath: string
	coordinate: { latitude: number; longitude: number }
}

/**
 * Why a coordinate produced no observation. Every one of these is a SILENCE the route owes an account of — an unnamed
 * silence and a silence for the right reason read identically on a receipt.
 */
export const DESIGNATION_REFUSALS = [
	/**
	 * The geocode reached no coordinate, so there is nothing to ask the layer about.
	 */
	"no_coordinate",
	/**
	 * The layer holds no coverage row for the location. Outside the authority's footprint, which is unknown and never a
	 * low-hazard reading.
	 */
	"outside_authority_footprint",
] as const

export type DesignationRefusal = (typeof DESIGNATION_REFUSALS)[number]

/**
 * What the route decided about one coordinate: an observation, or a named silence.
 */
export type DesignationDecision =
	| { fired: true; observation: AuthorityDesignationObservation }
	| { fired: false; refusal: DesignationRefusal }

export interface AuthorityDesignationRoute extends Disposable {
	identity: FloodLayerIdentity
	/**
	 * Decide one resolved coordinate. Pure with respect to the pipeline: it reads the layer and returns a record.
	 *
	 * `null` and `undefined` are both accepted because a geocode result carries `lat`/`lon` as nullable — a caller that
	 * had to narrow them first would be narrowing on this route's behalf, and a coordinate-less answer is a named refusal
	 * here rather than a caller's problem.
	 */
	observe: (latitude: number | null | undefined, longitude: number | null | undefined) => DesignationDecision
}

export interface AuthorityDesignationRouteOptions {
	/**
	 * The sealed layer to read. Required: there is no default layer, and a route that guessed one would report a
	 * designation from an authority nobody asked about.
	 */
	databasePath: string
}

/**
 * Build the route against one sealed layer.
 *
 * Everything that would make the route answer a well-formed wrong thing is refused by the reader's own constructor — a
 * manifest naming a different layer, a coverage table with no rows, a missing footprint row. Each of those would
 * otherwise present as a route that simply never fires, which on a receipt is indistinguishable from a region the
 * authority genuinely has not mapped.
 */
export function createAuthorityDesignationRoute(options: AuthorityDesignationRouteOptions): AuthorityDesignationRoute {
	const lookup = new FloodZoneLookup({ databasePath: options.databasePath })

	return {
		identity: lookup.identity,
		observe: (latitude, longitude) => {
			if (typeof latitude !== "number" || typeof longitude !== "number") {
				return { fired: false, refusal: "no_coordinate" }
			}

			return decide(lookup.lookup(latitude, longitude), lookup.identity, latitude, longitude, options.databasePath)
		},
		[Symbol.dispose]: () => lookup[Symbol.dispose](),
	}
}

/**
 * Turn one reading into a decision.
 */
function decide(
	reading: FloodZoneReading,
	identity: FloodLayerIdentity,
	latitude: number,
	longitude: number,
	databasePath: string
): DesignationDecision {
	if (reading.kind === FloodReadingKind.Unknown) {
		return { fired: false, refusal: "outside_authority_footprint" }
	}

	const { manifest, extent } = identity

	return {
		fired: true,
		observation: {
			reading: reading.kind,
			...(reading.zoneCode ? { code: reading.zoneCode } : {}),
			...(reading.definition ? { definition: reading.definition } : {}),
			...(reading.areaID ? { areaID: reading.areaID } : {}),
			containment: reading.containment,
			...observationCoverageRecord(reading.coverage),
			indexCellIndex: reading.indexCellIndex,
			extent: {
				authority: extent.authority,
				statement: extent.statement,
				statementURL: extent.statementURL,
			},
			limits: reading.limits,
			layer: observationLayerRecord(manifest),
			databasePath,
			coordinate: { latitude, longitude },
		},
	}
}

/**
 * One line a reader can check the claim from, with the authority and its vintage on it.
 */
export function describeAuthorityDesignation(observation: AuthorityDesignationObservation): string {
	const assigned = observation.code
		? `assigns ${observation.code}`
		: `assigns no zone, which its own guidance defines as ${observation.definition?.label ?? "the absent case"}`

	const coverage = observation.coverage
		? `coverage cell ${observation.coverage.h3CellIndex} (res ${observation.coverage.resolution}) on basis "${observation.coverage.basis}" at completeness ${observation.coverage.completeness.toFixed(4)}`
		: "no coverage row"

	return (
		`${observation.extent.authority}'s map ${assigned} at ${observation.coordinate.latitude}, ${observation.coordinate.longitude} ` +
		`(${observation.containment}); ${coverage}; from ${observation.layer.name} ${observation.layer.version} ` +
		`(${observation.layer.source} ${observation.layer.sourceVintage}, ${observation.layer.license}, build ${observation.layer.buildSHA})`
	)
}
