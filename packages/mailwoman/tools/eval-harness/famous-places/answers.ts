/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Grades the frozen famous-places test set by the place each row answers.
 *
 *   `score.ts` compares parse labels, and a parse can improve while the answer gets worse, because a label decides
 *   which geocoding path runs. This scorer sends each input through the geocoder and compares the coordinate with the
 *   row's truth point at the row's tolerance.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { haversine } from "@mailwoman/spatial/geometries/point/distance"
import { JSONSpliterator } from "spliterator"

import { loadForkEntityDeps } from "#geocode/session"
import { resolveCandidateDBPath } from "#resolver-backend"
import { FAMOUS_PLACES_FIXTURE, type FamousPlaceRow } from "#tools/eval-harness/famous-places/score"
import { buildGauntletDeps, runOne } from "#tools/eval-harness/gauntlet/harness"

/**
 * What a geocoder answered for one row.
 */
export interface FamousPlaceAnswer {
	lat: number | null
	lon: number | null
	tier: string | null
}

/**
 * How one answer compares with the row's truth point.
 */
export type FamousPlaceOutcome = "within_tolerance" | "wrong_place" | "no_coordinate"

/**
 * One row's graded answer.
 */
export interface GradedFamousPlaceAnswer {
	outcome: FamousPlaceOutcome
	/**
	 * The distance from the truth point, or `null` when the geocoder answered no coordinate.
	 */
	km: number | null
}

/**
 * Compares an answer with a row's truth point at the row's tolerance.
 */
export function gradeFamousPlaceAnswer(
	row: Pick<FamousPlaceRow, "lat" | "lon" | "tolerance_m">,
	answer: Pick<FamousPlaceAnswer, "lat" | "lon">
): GradedFamousPlaceAnswer {
	if (answer.lat == null || answer.lon == null) return { outcome: "no_coordinate", km: null }

	const km = haversine(row.lat, row.lon, answer.lat, answer.lon)

	return { outcome: km * 1000 <= row.tolerance_m ? "within_tolerance" : "wrong_place", km }
}

/**
 * The outcome counts of one kind and form.
 */
export type FamousPlaceAnswerCounts = Record<FamousPlaceOutcome, number> & { n: number }

/**
 * A row whose answer missed its truth point, listed so a report can state the address.
 */
export interface FamousPlaceAnswerMiss extends GradedFamousPlaceAnswer {
	input: string
	kind: string
	form: string
	lat: number | null
	lon: number | null
	tier: string | null
}

/**
 * The scorer's result.
 *
 * A host without the gazetteer or the POI layer reports `unread` with what it lacked, because
 * grading without them would report a low score for answers the production path never gave.
 */
export type FamousPlaceAnswersResult =
	| { status: "unread"; file: string; missing: string[] }
	| {
			status: "read"
			file: string
			n: number
			withinTolerance: number
			byKindForm: Record<string, FamousPlaceAnswerCounts>
			misses: FamousPlaceAnswerMiss[]
	  }

/**
 * Counts graded rows per `kind/form` and lists the rows that missed.
 */
export function tallyFamousPlaceAnswers(
	rows: ReadonlyArray<{
		row: Pick<FamousPlaceRow, "input" | "kind" | "form">
		answer: FamousPlaceAnswer
		graded: GradedFamousPlaceAnswer
	}>
): Pick<Extract<FamousPlaceAnswersResult, { status: "read" }>, "n" | "withinTolerance" | "byKindForm" | "misses"> {
	const byKindForm: Record<string, FamousPlaceAnswerCounts> = {}
	const misses: FamousPlaceAnswerMiss[] = []
	let withinTolerance = 0

	for (const { row, answer, graded } of rows) {
		const key = `${row.kind}/${row.form}`
		const cell = (byKindForm[key] ??= { within_tolerance: 0, wrong_place: 0, no_coordinate: 0, n: 0 })

		cell[graded.outcome]++

		cell.n++

		if (graded.outcome === "within_tolerance") {
			withinTolerance++
		} else {
			misses.push({ input: row.input, kind: row.kind, form: row.form, ...answer, ...graded })
		}
	}

	return { n: rows.length, withinTolerance, byKindForm, misses }
}

/**
 * Options for {@linkcode scoreFamousPlaceAnswers}.
 */
export interface ScoreFamousPlaceAnswersOptions {
	/**
	 * A package-shaped weights directory to grade in place of the installed model.
	 */
	weightsCacheRoot?: string
	/**
	 * A model file to grade in place of the installed model.
	 */
	modelPath?: string
	file?: string
	json?: string
}

/**
 * Reports which artifacts the production geocoding path needs and this host lacks.
 */
async function missingArtifacts(): Promise<string[]> {
	const missing: string[] = []

	if (!(await resolveCandidateDBPath())) {
		missing.push("candidate.db")
	}

	const probe = await loadForkEntityDeps({ dataRoot: dataRootPath(), forkEntity: true })

	probe.handle?.[Symbol.dispose]()

	if (!probe.deps.poiLookup) {
		missing.push("poi.db")
	}

	return missing
}

/**
 * Geocodes every fixture row and grades the coordinate.
 *
 * A row passes no country, because a person who types a bare name states none,
 * and this score measures that request.
 * Every narration line goes through `report`, one call per line.
 */
export async function scoreFamousPlaceAnswers(
	options: ScoreFamousPlaceAnswersOptions = {},
	report: (line: string) => void = console.log
): Promise<FamousPlaceAnswersResult> {
	const file = options.file || FAMOUS_PLACES_FIXTURE
	const missing = await missingArtifacts()

	if (missing.length) {
		const unread: FamousPlaceAnswersResult = { status: "unread", file, missing }

		report(`# famous places, place answers: NOT READ, this host lacks ${missing.join(", ")}`)

		if (options.json) {
			await writeLocalJSONFile(unread, options.json)
		}

		return unread
	}

	const fixture = await JSONSpliterator.fromAsync<FamousPlaceRow>(file).toArray()

	using deps = await buildGauntletDeps({
		...(options.weightsCacheRoot ? { weightsCacheRoot: options.weightsCacheRoot } : {}),
		...(options.modelPath ? { modelPath: options.modelPath } : {}),
	})

	const graded = []

	for (const row of fixture) {
		const { lat, lon, tier } = await runOne(row.input, deps)
		const answer: FamousPlaceAnswer = { lat, lon, tier }

		graded.push({ row, answer, graded: gradeFamousPlaceAnswer(row, answer) })
	}

	const result: FamousPlaceAnswersResult = { status: "read", file, ...tallyFamousPlaceAnswers(graded) }

	report(`# famous places, place answers: n=${result.n}, within tolerance ${result.withinTolerance}/${result.n}`)
	report("| kind/form | within tolerance | wrong place | no coordinate | n |\n| --- | --: | --: | --: | --: |")

	for (const [key, cell] of Object.entries(result.byKindForm).toSorted(([a], [b]) => a.localeCompare(b))) {
		report(`| ${key} | ${cell.within_tolerance} | ${cell.wrong_place} | ${cell.no_coordinate} | ${cell.n} |`)
	}

	if (options.json) {
		await writeLocalJSONFile(result, options.json)
	}

	return result
}
