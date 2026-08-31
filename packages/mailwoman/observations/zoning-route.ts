/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The zoning route, observation-only: after the resolver has produced a coordinate, the local authority's
 *   own zoning designation for that coordinate is recorded beside the answer — the authority's OWN CODE IN
 *   ITS OWN SPELLING, its description, the named plan it belongs to and that plan's stated window, and, where
 *   and only where the publisher itself publishes one, its national generic classification carried as a
 *   separate labelled value that never replaces the local code.
 *
 *   THE ROUTE READS; IT NEVER ANSWERS. It takes a finished coordinate and returns a record. Nothing here is
 *   consulted while an answer is being chosen, no candidate is read, no result is added, removed or
 *   re-ordered, and no abstain is reached or avoided because of it. A geocode with the route configured is
 *   the same geocode plus one advisory, which is a statement about construction rather than about a
 *   measurement.
 *
 *   PRESENCE IS THE SWITCH, AND IT IS A LAYER PATH. There is no boolean: a boolean would make the caller's
 *   factory construct the reader itself and put a sealed layer open on the default construction path. A
 *   session resolves the layer path, opens it if the file is there, and hands the route in; a session that
 *   finds no file hands in nothing and is byte-identical to one built before this route existed.
 *
 *   NO SCENARIO, BUT ALWAYS A JURISDICTION AND A PLAN. The coastal route answers under one of twelve named
 *   scenarios because its product publishes twelve. This product publishes one, so there is no scenario to
 *   name — and there is a JURISDICTION and a PLAN, which are part of the claim rather than parameters of it.
 *   A zone exists inside a named Development Plan or Local Area Plan adopted by a named authority, with a
 *   stated validity window; an observation that dropped either would report a designation nobody could trace
 *   to a plan.
 *
 *   ONLY A DESIGNATION REACHES A CALLER, AND THE SILENCE IS LOAD-BEARING. There is no absence observation
 *   here, and zoning is the hardest case for the rule: a location with no zoning polygon is outside any
 *   adopted plan area, or inside one on land the plan does not zone, or in a jurisdiction that has never
 *   adopted zoning, or in a jurisdiction whose records nobody has published — and no product distinguishes
 *   them. The publisher itself proves the asymmetry by stating `UNZ - Unzoned` as a POSITIVE value on a
 *   handful of rows: where it means unzoned it says so, so an absent row means nothing. The named refusal is
 *   what a receipt carries instead.
 *
 *   THE OBSERVATION IS ABOUT THE PLAN, NEVER ABOUT WHAT MAY BE BUILT. The publisher states that its data are
 *   "not published here as legal definitions of the current actuality with regard to Local Authority zoning
 *   or their geographic extents" and that "Original data should be sourced directly from the relevant Local
 *   Authority". So the wording reports what a plan assigns at a location, and the product's own exclusions
 *   ride on every observation.
 */

import {
	ZoningLookup,
	ZoningReadingKind,
	type ZoningContainmentPath,
	type ZoningDesignation,
	type ZoningLayerIdentity,
	type ZoningReading,
} from "@mailwoman/zoning"

import {
	observationCoverageRecord,
	observationLayerRecord,
	type ObservationCoverageRecord,
	type ObservationLayerRecord,
} from "#observations/layer-record"

/**
 * One zoning designation, recorded beside an answer.
 *
 * Everything a reader needs to check the claim is here: which authority, which plan and window, which product and
 * vintage, the polygons the location falls inside with each one's verbatim local code, how containment was established,
 * and the coverage record with the sentence saying what it does not license.
 */
export interface ZoningDesignationObservation {
	/**
	 * Always `designated`. `unknown` produces no observation — see this file's header.
	 */
	reading: ZoningReadingKind
	/**
	 * Every polygon containing the point. Usually one; several where a Local Area Plan overlays a Development Plan over
	 * the same ground, which the publisher issues as two rows.
	 */
	designations: ZoningDesignation[]
	containment: ZoningContainmentPath
	/**
	 * The coverage side of the claim. Its basis is `source_present`, which supports presence and nothing else.
	 */
	coverage?: ObservationCoverageRecord
	/**
	 * The index cell probed.
	 */
	indexCellIndex: string
	/**
	 * What the product does not state, in the publisher's own words.
	 */
	limits: ReadonlyArray<string>
	/**
	 * Why this layer's coverage licenses no claim that a location is unrestricted.
	 */
	coverageLimit: string
	layer: ObservationLayerRecord
	databasePath: string
	coordinate: { latitude: number; longitude: number }
}

/**
 * Why a coordinate produced no observation. Every one of these is a SILENCE the route owes an account of — an unnamed
 * silence and a silence for the right reason read identically on a receipt.
 */
export const ZONING_REFUSALS = [
	/**
	 * The geocode reached no coordinate, so there is nothing to ask the layer about.
	 */
	"no_coordinate",
	/**
	 * No adopted plan in this product assigns a zoning designation here. NOT an absence claim: the location may be
	 * outside any plan area, inside one on land the plan does not zone, in a jurisdiction that has never zoned, or in one
	 * whose records are not published — and the product cannot tell those apart.
	 */
	"no_designation_here",
] as const

export type ZoningRefusal = (typeof ZONING_REFUSALS)[number]

/**
 * What the route decided about one coordinate: an observation, or a named silence.
 */
export type ZoningDecision =
	| { fired: true; observation: ZoningDesignationObservation }
	| { fired: false; refusal: ZoningRefusal }

export interface ZoningDesignationRoute extends Disposable {
	identity: ZoningLayerIdentity
	/**
	 * Decide one resolved coordinate. Pure with respect to the pipeline: it reads the layer and returns a record.
	 *
	 * `null` and `undefined` are both accepted because a geocode result carries `lat`/`lon` as nullable — a caller that
	 * had to narrow them first would be narrowing on this route's behalf, and a coordinate-less answer is a named refusal
	 * here rather than a caller's problem.
	 */
	observe: (latitude: number | null | undefined, longitude: number | null | undefined) => ZoningDecision
}

export interface ZoningDesignationRouteOptions {
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
 * manifest naming a different layer, a coverage table with no rows, an empty jurisdiction table, and above all a
 * coverage row whose basis would support an exclusion. That last one would otherwise present as a route reporting
 * unmapped and unzoned land alike as free of restriction.
 */
export function createZoningDesignationRoute(options: ZoningDesignationRouteOptions): ZoningDesignationRoute {
	const lookup = new ZoningLookup({ databasePath: options.databasePath })

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
	reading: ZoningReading,
	identity: ZoningLayerIdentity,
	latitude: number,
	longitude: number,
	databasePath: string
): ZoningDecision {
	if (reading.kind !== ZoningReadingKind.Designated) {
		return { fired: false, refusal: "no_designation_here" }
	}

	const { manifest } = identity

	return {
		fired: true,
		observation: {
			reading: reading.kind,
			designations: reading.designations,
			containment: reading.containment,
			...observationCoverageRecord(reading.coverage),
			indexCellIndex: reading.indexCellIndex,
			limits: reading.limits,
			coverageLimit: reading.coverageLimit,
			layer: observationLayerRecord(manifest),
			databasePath,
			coordinate: { latitude, longitude },
		},
	}
}

/**
 * One line a reader can check the claim from, with the authority, the plan and the vintage on it.
 */
export function describeZoningDesignation(observation: ZoningDesignationObservation): string {
	const first = observation.designations[0]

	const assigned = first
		? `${first.jurisdiction.name} zones the location ${JSON.stringify(first.localCode)}` +
			(first.crosswalk ? ` (${first.crosswalk.scheme} ${first.crosswalk.code})` : "") +
			` under ${first.plan.name}` +
			(observation.designations.length > 1 ? ` (and ${observation.designations.length - 1} more plan(s) here)` : "")
		: "an adopted plan zones the location"

	const coverage = observation.coverage
		? `coverage cell ${observation.coverage.h3CellIndex} (res ${observation.coverage.resolution}) on basis "${observation.coverage.basis}"`
		: "no coverage row"

	return (
		`${assigned} at ${observation.coordinate.latitude}, ${observation.coordinate.longitude} ` +
		`(${observation.containment}); ${coverage}; from ${observation.layer.name} ${observation.layer.version} ` +
		`(${observation.layer.source} ${observation.layer.sourceVintage}, tier ${observation.layer.tier}, ` +
		`licence ${observation.layer.license}, build ${observation.layer.buildSHA})`
	)
}
