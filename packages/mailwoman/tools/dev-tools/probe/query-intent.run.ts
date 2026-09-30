/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The end-to-end receipt for the ROAD_TO_V9 §4 intent vocabulary: run real queries through the
 *   real geocode cascade. The probe prints each answer beside its markers.
 *   It needs the ~9 GB database set to measure candidate-table populations. CI does not hold that data.
 *   The probe reads `$MAILWOMAN_DATA_ROOT` in read-only mode.
 *   Link the dev weights with `node neural-weights-en-us/scripts/link-dev-weights.ts` after `yarn compile`.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { buildGauntletDeps } from "#tools/eval-harness/gauntlet/harness"

/**
 * The hard-case board's `bare_namesake` and `fst_out_of_reach` surfaces plus three controls.
 *
 * The controls include a full address and its lowercase form.
 * The third control is a route pair.
 */
const DEFAULT_BOARD = [
	"Springfield",
	"Portland",
	"Paris",
	"Bordeaux",
	"Richmond",
	"Cambridge",
	"Athens",
	"Lebanon",
	"Preston",
	"Columbus",
	"Bristol",
	"Dublin",
	"Wellington",
	"Santiago",
	"Stanley",
	"Hamilton",
	"Moscow",
	"Berlin",
	"Manchester",
	"Fulda",
	"Trier",
	"350 5th Ave, New York, NY 10118",
	"350 5th ave, new york, ny 10118",
	"12 rue de Rome, 75008 Paris",
	"Paris London",
	"gas station near me",
]

const { positionals } = parseArguments({ allowPositionals: true })
const board = positionals.length ? positionals : DEFAULT_BOARD
const deps = await buildGauntletDeps()

console.log(["query", "lat", "lon", "tier", "candidates", "markers", "evidence"].join("\t"))

for (const query of board) {
	const result = await deps.geocode(query)

	console.log(
		[
			query,
			result.lat ?? "-",
			result.lon ?? "-",
			result.resolution_tier,
			result.candidates.length,
			result.intent_markers.map((m) => m.code).join(",") || "-",
			result.intent_markers.length ? stringifyJSON(result.intent_markers[0]!.evidence ?? {}) : "-",
		].join("\t")
	)
}

deps[Symbol.dispose]()
