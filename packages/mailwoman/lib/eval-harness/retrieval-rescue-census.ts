/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Report whether a correct answer was already available for each coordinate-truth row:
 *   through the entity layer or among unselected resolver candidates.
 *   This census classifies rows but makes no decision about changing checks or behavior.
 */

import { haversineKm } from "@mailwoman/spatial"

import { DEFAULT_TOL_M } from "#eval-harness/gauntlet/check-case"

/**
 * Classification of delivered answers, available entity/ranked rescues, or ungraded rows.
 *
 * `checkProtects` separately marks correct rows that an unconditional entity hit could affect.
 */
export type RescueClass =
	| "correct_as_is"
	| "entity_rescued_already"
	| "rescue_available_entity"
	| "rescue_available_rank"
	| "rescue_available_both"
	| "no_rescue_on_hand"
	| "ungraded"

export interface RescueCandidate {
	lat: number
	lon: number
}

export interface RescueRowInput {
	/**
	 * Truth, when the row carries a coordinate pin.
	 */
	expectLat?: number
	expectLon?: number
	expectToleranceM?: number
	/**
	 * The delivered answer (post entity tiers — production behavior).
	 */
	lat: number | null
	lon: number | null
	/**
	 * True when the delivered result includes `entity` — the #1585 wire fired under the current check.
	 */
	entityFired: boolean
	/**
	 * The unconditional fork-entity probe's hit for this input, when a `declared_fork`
	 * marker rode and the probe was asked ignoring check 1.
	 *
	 * Undefined = probe not applicable or no hit.
	 */
	unconditionalEntityHit?: RescueCandidate
	/**
	 * The resolver's ranked alternatives excluding the winner (`candidates[1..]` of the delivered result).
	 */
	alternateCandidates: readonly RescueCandidate[]
}

export interface RescueRowReport {
	id: string
	input: string
	country?: string
	markers: string[]
	classification: RescueClass
	/**
	 * Distance from the delivered answer to truth, km — undefined when ungraded or unresolved.
	 */
	deliveredKm?: number
	/**
	 * Rank (1-based within the alternates) of the first alternate inside tolerance, when one exists.
	 */
	rescueRank?: number
	/**
	 * The row is correct as delivered while an unconditional entity hit exists —
	 * the set a check loosening puts at risk.
	 *
	 * Reported beside the classification, never instead of it.
	 */
	checkProtects: boolean
}

function within(lat: number, lon: number, row: RescueRowInput): boolean {
	const tolKm = (row.expectToleranceM ?? DEFAULT_TOL_M) / 1000

	return haversineKm(lat, lon, row.expectLat!, row.expectLon!) <= tolKm
}

/**
 * Classify one row using only its supplied values.
 */
export function classifyRescueRow(row: RescueRowInput): {
	classification: RescueClass
	checkProtects: boolean
	deliveredKm?: number
	rescueRank?: number
} {
	if (row.expectLat === undefined || row.expectLon === undefined) {
		return { classification: "ungraded", checkProtects: false }
	}

	const deliveredKm =
		row.lat !== null && row.lon !== null ? haversineKm(row.lat, row.lon, row.expectLat, row.expectLon) : undefined

	const deliveredCorrect = row.lat !== null && row.lon !== null && within(row.lat, row.lon, row)

	const entityHitCorrect =
		row.unconditionalEntityHit !== undefined &&
		within(row.unconditionalEntityHit.lat, row.unconditionalEntityHit.lon, row)

	let rescueRank: number | undefined

	for (const [index, candidate] of row.alternateCandidates.entries()) {
		if (within(candidate.lat, candidate.lon, row)) {
			rescueRank = index + 1

			break
		}
	}

	// Track correct rows with an entity hit as risks if the check is loosened.
	const checkProtects = deliveredCorrect && row.unconditionalEntityHit !== undefined

	if (deliveredCorrect) {
		return {
			classification: row.entityFired ? "entity_rescued_already" : "correct_as_is",
			checkProtects,
			...(deliveredKm === undefined ? {} : { deliveredKm }),
		}
	}

	const classification: RescueClass =
		entityHitCorrect && rescueRank !== undefined
			? "rescue_available_both"
			: entityHitCorrect
				? "rescue_available_entity"
				: rescueRank !== undefined
					? "rescue_available_rank"
					: "no_rescue_on_hand"

	return {
		classification,
		checkProtects: false,
		...(deliveredKm === undefined ? {} : { deliveredKm }),
		...(rescueRank === undefined ? {} : { rescueRank }),
	}
}

export interface RescueSummary {
	rows: number
	graded: number
	counts: Record<RescueClass, number>
	checkProtects: number
}

export function summarizeRescue(reports: readonly RescueRowReport[]): RescueSummary {
	const counts: Record<RescueClass, number> = {
		correct_as_is: 0,
		entity_rescued_already: 0,
		rescue_available_entity: 0,
		rescue_available_rank: 0,
		rescue_available_both: 0,
		no_rescue_on_hand: 0,
		ungraded: 0,
	}

	let checkProtects = 0

	for (const report of reports) {
		counts[report.classification]++

		if (report.checkProtects) {
			checkProtects++
		}
	}

	return {
		rows: reports.length,
		graded: reports.length - counts.ungraded,
		counts,
		checkProtects,
	}
}
