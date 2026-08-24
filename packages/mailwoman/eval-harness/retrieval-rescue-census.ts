/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Retrieval-rescue census (#1878) — report-only. For every coordinate-truth board row, classify whether a CORRECT
 *   answer was available even when the delivered answer was wrong: in the fork→entity layer (probed UNCONDITIONALLY,
 *   ignoring `fork-entity.ts` gate 1), or sitting unpicked in the resolver's own ranked `candidates` list.
 *
 *   The question this measures is the next release's framing: when a parse goes wrong, how often is the right answer
 *   already on hand? `COMER parís.méxico` is the worked case both ways — the shipped model wins it because a wrong but
 *   UNRESOLVABLE parse lets the incumbent abstain and the entity layer answer; the v5-line candidates lose it because a
 *   wrong but RESOLVABLE parse (locality "COMER" → Comer, Georgia, US) silences the same on-hand answer.
 *
 *   Classification is pure and the runner is dumb: everything here is testable without a board, and the runner only
 *   feeds it results. This census emits NO verdict about any gate change — it names rows; the rows then get per-row
 *   trace reads before any decode or resolver behavior moves (the decoder-grammar contract's graduation rule).
 */

import { haversineKm } from "@mailwoman/spatial"

import { DEFAULT_TOL_M } from "./gauntlet/check-case.ts"

/**
 * The six ways a truth-graded row can relate to the answers on hand, plus the ungraded bucket.
 *
 * - `correct_as_is` — the delivered answer is inside tolerance; no rescue question arises.
 * - `entity_rescued_already` — the #1585 wire fired (the result carries `entity`) and the answer is correct: the CURRENT
 *   mechanism already performed the rescue.
 * - `rescue_available_entity` — delivered answer wrong; the unconditional fork-entity probe holds a hit inside tolerance.
 *   The gate (incumbent resolved) is what stands between the row and the right answer.
 * - `rescue_available_rank` — delivered answer wrong; a NON-WINNING entry of the resolver's own `candidates` list is
 *   inside tolerance. The ranking, not the retrieval, lost the row.
 * - `rescue_available_both` — both of the above hold.
 * - `no_rescue_on_hand` — delivered answer wrong and neither source holds the truth: these rows need retrieval or parse
 *   work, not rescue plumbing.
 * - `gate_protects` is NOT a value here — it is a separate boolean, because it can hold alongside `correct_as_is`: the
 *   row is correct AND an unconditional entity hit exists (necessarily elsewhere, or redundant), so loosening the gate
 *   puts the row at risk. The loosening decision needs both lists, not one label.
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
	 * True when the delivered result carries `entity` — the #1585 wire fired under the current gate.
	 */
	entityFired: boolean
	/**
	 * The unconditional fork-entity probe's hit for this input, when a `declared_fork` marker rode and the probe was
	 * asked IGNORING gate 1. Undefined = probe not applicable or no hit.
	 */
	unconditionalEntityHit?: RescueCandidate
	/**
	 * The resolver's ranked alternatives EXCLUDING the winner (`candidates[1..]` of the delivered result).
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
	 * The row is CORRECT as delivered while an unconditional entity hit exists — the set a gate loosening puts at risk.
	 * Reported beside the classification, never instead of it.
	 */
	gateProtects: boolean
}

function within(lat: number, lon: number, row: RescueRowInput): boolean {
	const tolKm = (row.expectToleranceM ?? DEFAULT_TOL_M) / 1000

	return haversineKm(lat, lon, row.expectLat!, row.expectLon!) <= tolKm
}

/**
 * Classify one row. Pure: every input is a value, no lookups.
 */
export function classifyRescueRow(row: RescueRowInput): {
	classification: RescueClass
	gateProtects: boolean
	deliveredKm?: number
	rescueRank?: number
} {
	if (row.expectLat === undefined || row.expectLon === undefined) {
		return { classification: "ungraded", gateProtects: false }
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

	// A correct row with an unconditional entity hit is the loosening-risk set — even a CORRECT entity hit belongs in
	// it, because a changed gate reorders which mechanism answers, and reordering is a behavior change to re-grade.
	const gateProtects = deliveredCorrect && row.unconditionalEntityHit !== undefined

	if (deliveredCorrect) {
		return {
			classification: row.entityFired ? "entity_rescued_already" : "correct_as_is",
			gateProtects,
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
		gateProtects: false,
		...(deliveredKm === undefined ? {} : { deliveredKm }),
		...(rescueRank === undefined ? {} : { rescueRank }),
	}
}

export interface RescueSummary {
	rows: number
	graded: number
	counts: Record<RescueClass, number>
	gateProtects: number
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

	let gateProtects = 0

	for (const report of reports) {
		counts[report.classification]++

		if (report.gateProtects) {
			gateProtects++
		}
	}

	return {
		rows: reports.length,
		graded: reports.length - counts.ungraded,
		counts,
		gateProtects,
	}
}
