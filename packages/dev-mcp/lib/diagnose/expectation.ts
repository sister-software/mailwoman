/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @file Diagnosed-row expectation grading.
 */

import { checkCase } from "mailwoman/eval-harness/gauntlet/check-case"
import { toGauntletResult } from "mailwoman/eval-harness/gauntlet/harness"
import type { GauntletCaseTable } from "mailwoman/eval-harness/gauntlet/schema"
import type { GeocodeRun } from "mailwoman/geocode"

import { caseCarriesTruth, seedToCaseTable } from "#grade"
import type { ResolvedInput } from "#input-sets"

/**
 * How the row was graded, and against what. `met: null` means the row asserts nothing — never that it passed.
 */
export interface ExpectationReading {
	source: "board_case" | "corpus_row" | "none"
	met: boolean | null
	issues: string[]
}

//#region Expectations

/**
 * The case table this row is graded against, or `null` when it asserts nothing.
 *
 * A board row carries a `SeedCase` and grades through the board's own `checkCase`. A panel / holdout / golden / parity
 * row carries expectations without a seed, so one is SYNTHESIZED around what its corpus actually pinned — the same
 * grader then reads both, which is what keeps a second grading path from appearing here.
 */
export function expectationCase(
	item: ResolvedInput
): { table: GauntletCaseTable; source: "board_case" | "corpus_row" } | null {
	if (item.seed) {
		return caseCarriesTruth(item.seed) ? { table: seedToCaseTable(item.seed), source: "board_case" } : null
	}

	const hasCoordinate = typeof item.truthLat === "number" && typeof item.truthLon === "number"

	if (!hasCoordinate && !item.expectComponents) return null

	return {
		source: "corpus_row",
		table: {
			id: item.id,
			input: item.input,
			source: "dev-mcp:diagnose",
			address_kind: item.addressKind ?? "unknown",
			country: item.country ?? "",
			status: "pass",
			expect_components: item.expectComponents ? JSON.stringify(item.expectComponents) : null,
			expect_component_renderings: null,
			expect_place_id: null,
			expect_place_name: null,
			expect_lat: item.truthLat ?? null,
			expect_lon: item.truthLon ?? null,
			// Null where the corpus pinned none, so `checkCase` applies its own default rather than this module
			// inventing a tolerance no corpus agreed to.
			expect_tolerance_m: item.toleranceM ?? null,
			expect_tier: null,
			default_country: null,
			added_at: "",
			bug_ref: null,
			note: null,
			ablation_expect: null,
			locale: null,
			expect_abstain: null,
		},
	}
}

/**
 * Grade one row against whatever its corpus pinned.
 *
 * Typed against the real `GeocodeResult` rather than {@link AccountInput}: `checkCase` reads the gauntlet projection,
 * and projecting twice is how a recorded answer and the live one it came from stop agreeing.
 */
export function gradeExpectation(item: ResolvedInput, result: GeocodeRun["result"]): ExpectationReading {
	const expectation = expectationCase(item)

	if (!expectation) return { source: "none", met: null, issues: [] }

	const issues = checkCase(expectation.table, toGauntletResult(result))

	return { source: expectation.source, met: issues.length === 0, issues }
}

//#endregion
