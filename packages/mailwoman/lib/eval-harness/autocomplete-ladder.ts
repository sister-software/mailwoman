/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The autocomplete ladder (#2154): every board row cut at every prefix boundary, each rung graded against the
 *   row's own truth, on two arms — the parse → resolve path today's Photon `/api` runs on a partial query, and the FST
 *   autocomplete tier. Four readings per row per arm: the FIRST-HIT rung (how many characters before the truth enters
 *   the top-k), STABILITY (once in, does it stay in on every later rung), LATENCY per rung-length band, and ABSTENTION
 *   on the one- and two-character rungs where the right answer is no answer.
 *
 *   THE LOCALE HINT IS PART OF THE INPUT. A finished address carries its own country evidence; `Ru` carries none, and a
 *   first-hit rung measured without the hint grades the gazetteer's population prior rather than autocomplete. Every
 *   rung therefore runs under the row's country, and a row with none is REFUSED rather than graded.
 *
 *   NO NEW TRUTH. The ladder is derived from rows that already carry a coordinate and a tolerance; the full-string rung
 *   is the ordinary board grade for that row, and a difference there is a harness defect, not a finding.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalBuffer } from "@mailwoman/core/fs/readers"
import { percentile } from "@mailwoman/core/stats"
import { autocomplete, deserializeFST, type FSTMatcher } from "@mailwoman/resolver-wof-sqlite/fst"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { loadRegressionCases } from "#eval-harness/gauntlet/cases/load"
import type { SeedCase } from "#eval-harness/gauntlet/cases/seed-case"
import { DEFAULT_TOL_M } from "#eval-harness/gauntlet/check-case"
import { buildGauntletDeps, type GauntletDepsOptions, type GauntletGeocodeOpts } from "#eval-harness/gauntlet/harness"
import { routeCountry } from "#eval-harness/gauntlet/routing"

/**
 * The two arms. `parse_resolve` is what `@mailwoman/photon`'s `/api` runs on a prefix today and answers ONE coordinate;
 * `fst` is the autocomplete tier, answering up to `topK` suggestions.
 */
export const LADDER_ARMS = ["parse_resolve", "fst"] as const

export type LadderArm = (typeof LADDER_ARMS)[number]

/**
 * Photon's default `limit`, and the menu depth a hit is graded against on the `fst` arm.
 */
export const LADDER_TOP_K = 5

/**
 * Rung-length bands the latency percentiles are reported over, in characters.
 */
export const LADDER_LENGTH_BANDS: ReadonlyArray<readonly [label: string, min: number, max: number]> = [
	["1-2", 1, 2],
	["3-5", 3, 5],
	["6-12", 6, 12],
	["13+", 13, Number.POSITIVE_INFINITY],
]

/**
 * A rung this short expects NO confident answer: one or two characters name nothing.
 */
export const ABSTAIN_EXPECTED_MAX_CHARS = 2

/**
 * A row whose truth tolerance exceeds this is ladder-eligible but stratified out of the headline: a region centroid
 * sits inside the top-5 of almost any prefix.
 */
export const HEADLINE_MAX_TOLERANCE_M = 25_000

/**
 * Which per-locale FST the `fst` arm reads for a row's country. This is NOT the weights-overlay routing
 * (`OVERLAY_LOCALE_BY_COUNTRY`), which falls back to en-US for every country without an overlay: an FST is
 * country-scoped by construction, and grading a French row against the US FST would report "never" for `Paris` as a
 * property of the tier rather than of the artifact chosen. A country with no FST here answers nothing on that arm and
 * is counted out of its denominator, never graded as a miss.
 */
export const FST_LOCALE_BY_COUNTRY: Readonly<Record<string, string>> = {
	US: "en-us",
	GB: "en-gb",
	FR: "fr-fr",
	DE: "de-de",
	ES: "es-es",
	IT: "it-it",
	JP: "ja-jp",
	KR: "ko-kr",
	CN: "zh-cn",
}

/**
 * How many single-character rungs open the ladder before token boundaries take over: the first three keystrokes are
 * where an autocomplete front decides whether to answer at all, and beyond three a per-character rung adds latency
 * samples without adding a decision.
 */
export const FIRST_KEYSTROKE_RUNGS = 3

/**
 * The prefixes of one input, shortest first, ending with the full string.
 *
 * The first three single characters stand in for the first keystrokes; after that a rung opens at every token boundary
 * — a run of whitespace or a comma — so `Rua Augusta 100, Lisboa` yields `R`, `Ru`, `Rua`, `Rua Augusta`, `Rua Augusta
 * 100`, `Rua Augusta 100, Lisboa`. Trailing separators are trimmed, because a user's screen does not send the space
 * until the next letter arrives.
 */
export function ladderRungs(input: string): string[] {
	const rungs: string[] = []
	const seen = new Set<string>()

	const push = (prefix: string) => {
		const trimmed = prefix.replace(/[\s,]+$/u, "")

		if (!trimmed || seen.has(trimmed)) return

		seen.add(trimmed)
		rungs.push(trimmed)
	}

	for (let n = 1; n <= FIRST_KEYSTROKE_RUNGS && n <= input.length; n++) {
		push(input.slice(0, n))
	}

	for (let i = 1; i < input.length; i++) {
		if (/[\s,]/u.test(input[i]!) && !/[\s,]/u.test(input[i - 1]!)) {
			push(input.slice(0, i))
		}
	}

	push(input)

	return rungs
}

/**
 * One rung's measurement on one arm.
 */
export interface RungReading {
	prefix: string
	chars: number
	/**
	 * Every coordinate the arm answered, top first — one for `parse_resolve`, up to {@link LADDER_TOP_K} for `fst`.
	 */
	answers: Array<{ lat: number; lon: number }>
	/**
	 * Whether any answer is within the row's tolerance of the truth.
	 */
	hit: boolean
	latencyMs: number
}

/**
 * One row on one arm, read off its rungs.
 */
export interface RowArmReading {
	rungs: RungReading[]
	/**
	 * Characters typed before the truth first entered the answers, or `null` when it never did.
	 */
	firstHitChars: number | null
	/**
	 * `firstHitChars` over the full input length, so rows of different lengths compare.
	 */
	firstHitFraction: number | null
	/**
	 * After the first hit, how many later rungs LOST the truth again. `0` is a stable row; `null` when it never hit.
	 */
	churn: number | null
	/**
	 * Rungs of at most {@link ABSTAIN_EXPECTED_MAX_CHARS} characters that answered anything at all.
	 */
	shortRungsAnswered: number
	shortRungs: number
	/**
	 * Whether the full-string rung hit — the ordinary board grade for the row on this arm.
	 */
	fullStringHit: boolean
}

/**
 * Fold rungs into the per-row readings. Pure, so the arithmetic is testable without an engine.
 */
export function readRow(rungs: readonly RungReading[], inputLength: number): RowArmReading {
	const firstIndex = rungs.findIndex((rung) => rung.hit)
	const first = firstIndex === -1 ? null : rungs[firstIndex]!
	const churn = first === null ? null : rungs.slice(firstIndex + 1).filter((rung) => !rung.hit).length
	const shortOnes = rungs.filter((rung) => rung.chars <= ABSTAIN_EXPECTED_MAX_CHARS)

	return {
		rungs: [...rungs],
		firstHitChars: first?.chars ?? null,
		firstHitFraction: first ? first.chars / inputLength : null,
		churn,
		shortRungsAnswered: shortOnes.filter((rung) => rung.answers.length > 0).length,
		shortRungs: shortOnes.length,
		fullStringHit: rungs.at(-1)?.hit ?? false,
	}
}

export interface LadderRow {
	id: string
	input: string
	country: string
	status: SeedCase["status"]
	toleranceM: number
	/**
	 * Whether the row counts toward the headline (tolerance at or under {@link HEADLINE_MAX_TOLERANCE_M}).
	 */
	headline: boolean
	/**
	 * The FST locale the `fst` arm read, or `null` when the row's country has none — the arm then answered nothing and
	 * the row is outside that arm's denominators.
	 */
	fstLocale: string | null
	arms: Record<LadderArm, RowArmReading>
}

export interface LatencyBand {
	band: string
	n: number
	p50Ms: number | null
	p95Ms: number | null
}

export interface ArmSummary {
	arm: LadderArm
	/**
	 * Headline rows the arm could answer — for `fst`, those whose country has an FST.
	 */
	rows: number
	/**
	 * Headline rows left out of this arm's denominators because it had no artifact for them.
	 */
	rowsWithoutArtifact: number
	/**
	 * Rows whose truth entered the answers at SOME rung.
	 */
	rowsHit: number
	/**
	 * Median of `firstHitFraction` over the rows that hit.
	 */
	medianFirstHitFraction: number | null
	/**
	 * Rows that hit and then lost the truth on a later rung, over the rows that hit.
	 */
	churnRows: number
	shortRungsAnswered: number
	shortRungs: number
	fullStringHits: number
	latency: LatencyBand[]
}

export interface AutocompleteLadderReport {
	generatedAt: string
	country: string | null
	topK: number
	rows: LadderRow[]
	/**
	 * Rows read but left out of every summary, each with the reason.
	 */
	excluded: Array<{ id: string; reason: string }>
	summaries: ArmSummary[]
	/**
	 * Headline rows where the two arms first hit at different rungs, or one never did.
	 */
	disagreements: Array<{ id: string; input: string; parse_resolve: number | null; fst: number | null }>
}

export interface AutocompleteLadderOptions extends GauntletDepsOptions {
	country?: string
	limit?: number
	/**
	 * Directory of per-locale FST binaries (`fst-<locale>.bin`). Default `$MAILWOMAN_DATA_ROOT/wof/fst-per-locale`.
	 */
	fstDir?: string
	/**
	 * The WOF admin database the `fst` arm reads suggestion coordinates from.
	 */
	adminDB?: string
	quiet?: boolean
}

/**
 * Locale tag → FST filename, lower-cased on both halves because that is what the builder writes.
 */
function fstFileName(locale: string): string {
	return `fst-${locale}.bin`
}

/**
 * Run the ladder over the board.
 */
export async function runAutocompleteLadder(
	options: AutocompleteLadderOptions = {}
): Promise<AutocompleteLadderReport> {
	const country = options.country?.toUpperCase()
	const all = await loadRegressionCases()
	const excluded: AutocompleteLadderReport["excluded"] = []

	const eligible = all.filter((row) => {
		if (country && row.country.toUpperCase() !== country) return false

		if (row.expectLat === undefined || row.expectLon === undefined) {
			excluded.push({ id: row.id, reason: "no truth coordinate" })

			return false
		}

		if (!routeCountry(row)) {
			excluded.push({ id: row.id, reason: "no locale hint — a rung graded without one measures the population prior" })

			return false
		}

		return true
	})

	const selected = options.limit ? eligible.slice(0, options.limit) : eligible
	const fstDir = options.fstDir ?? String(dataRootPath("wof", "fst-per-locale"))
	const adminDB = options.adminDB ?? String(dataRootPath("wof", "admin-global-priority.db"))

	using deps = await buildGauntletDeps(options)
	using admin = new DatabaseClient<WOFDatabase>(adminDB, { readOnly: true })

	const matchers = new Map<string, FSTMatcher | null>()

	const matcherFor = async (locale: string): Promise<FSTMatcher | null> => {
		const cached = matchers.get(locale)

		if (cached !== undefined) return cached

		const path = `${fstDir}/${fstFileName(locale)}`
		const matcher = (await pathExists(path)) ? deserializeFST(await readLocalBuffer(path)) : null

		if (!matcher && !options.quiet) {
			console.error(`[autocomplete-ladder] no FST at ${path} — the fst arm answers nothing for ${locale}`)
		}

		matchers.set(locale, matcher)

		return matcher
	}

	const coordinatesFor = async (wofIDs: readonly number[]): Promise<Map<number, { lat: number; lon: number }>> => {
		const out = new Map<number, { lat: number; lon: number }>()

		if (!wofIDs.length) return out

		const rows = await admin
			.selectFrom("spr")
			.select(["id", "latitude", "longitude"])
			.where("id", "in", [...wofIDs])
			.execute()

		for (const row of rows) {
			// `0,0` is the gazetteer's unlocated sentinel, not a place in the Gulf of Guinea.
			if (row.latitude === 0 && row.longitude === 0) continue

			out.set(row.id, { lat: row.latitude, lon: row.longitude })
		}

		return out
	}

	const rows: LadderRow[] = []
	let warmed = false

	for (const row of selected) {
		const overlayCountry = routeCountry(row)!
		const toleranceM = row.expectToleranceM ?? DEFAULT_TOL_M
		const tolKm = toleranceM / 1000

		const within = (lat: number, lon: number) => haversineKm(lat, lon, row.expectLat!, row.expectLon!) <= tolKm

		const geoOpts: GauntletGeocodeOpts = {
			caseCountry: overlayCountry,
			defaultCountry: row.defaultCountry ?? row.country,
			fuzzyCountryScope: row.country,
		}

		const fstLocale = FST_LOCALE_BY_COUNTRY[row.country.toUpperCase()] ?? null
		const matcher = fstLocale ? await matcherFor(fstLocale) : null
		const rungs = ladderRungs(row.input)

		// The first request of a process pays engine construction; it is not a rung's latency.
		if (!warmed) {
			await deps.geocode(rungs.at(-1)!, geoOpts)
			warmed = true
		}

		const parseReadings: RungReading[] = []
		const fstReadings: RungReading[] = []

		for (const prefix of rungs) {
			const startedParse = performance.now()
			const geocoded = await deps.geocode(prefix, geoOpts)
			const parseMs = performance.now() - startedParse

			const parseAnswers =
				geocoded.lat != null && geocoded.lon != null ? [{ lat: geocoded.lat, lon: geocoded.lon }] : []

			parseReadings.push({
				prefix,
				chars: prefix.length,
				answers: parseAnswers,
				hit: parseAnswers.some((answer) => within(answer.lat, answer.lon)),
				latencyMs: parseMs,
			})

			const startedFST = performance.now()
			const suggestions = matcher ? autocomplete(matcher, prefix, { maxSuggestions: LADDER_TOP_K }).suggestions : []
			const coordinates = await coordinatesFor(suggestions.map((suggestion) => suggestion.wofID))
			const fstMs = performance.now() - startedFST

			const fstAnswers = suggestions.flatMap((suggestion) => {
				const found = coordinates.get(suggestion.wofID)

				return found ? [found] : []
			})

			fstReadings.push({
				prefix,
				chars: prefix.length,
				answers: fstAnswers,
				hit: fstAnswers.some((answer) => within(answer.lat, answer.lon)),
				latencyMs: fstMs,
			})
		}

		rows.push({
			id: row.id,
			input: row.input,
			country: row.country,
			status: row.status,
			toleranceM,
			headline: toleranceM <= HEADLINE_MAX_TOLERANCE_M,
			fstLocale: matcher ? fstLocale : null,
			arms: {
				parse_resolve: readRow(parseReadings, row.input.length),
				fst: readRow(fstReadings, row.input.length),
			},
		})
	}

	return {
		generatedAt: new Date().toISOString(),
		country: country ?? null,
		topK: LADDER_TOP_K,
		rows,
		excluded,
		summaries: LADDER_ARMS.map((arm) => summarizeArm(arm, rows)),
		disagreements: rows
			.filter(
				(row) =>
					row.headline && row.fstLocale !== null && row.arms.parse_resolve.firstHitChars !== row.arms.fst.firstHitChars
			)
			.map((row) => ({
				id: row.id,
				input: row.input,
				parse_resolve: row.arms.parse_resolve.firstHitChars,
				fst: row.arms.fst.firstHitChars,
			})),
	}
}

/**
 * The per-arm summary over the HEADLINE rows. Pure.
 */
export function summarizeArm(arm: LadderArm, rows: readonly LadderRow[]): ArmSummary {
	const allHeadline = rows.filter((row) => row.headline)
	const headline = arm === "fst" ? allHeadline.filter((row) => row.fstLocale !== null) : allHeadline
	const readings = headline.map((row) => row.arms[arm])
	const hits = readings.filter((reading) => reading.firstHitFraction !== null)
	const latencies = headline.flatMap((row) => row.arms[arm].rungs)

	return {
		arm,
		rows: headline.length,
		rowsWithoutArtifact: allHeadline.length - headline.length,
		rowsHit: hits.length,
		medianFirstHitFraction: percentile(
			hits.map((reading) => reading.firstHitFraction!),
			50
		),
		churnRows: hits.filter((reading) => (reading.churn ?? 0) > 0).length,
		shortRungsAnswered: readings.reduce((n, reading) => n + reading.shortRungsAnswered, 0),
		shortRungs: readings.reduce((n, reading) => n + reading.shortRungs, 0),
		fullStringHits: readings.filter((reading) => reading.fullStringHit).length,
		latency: LADDER_LENGTH_BANDS.map(([band, min, max]) => {
			const inBand = latencies.filter((rung) => rung.chars >= min && rung.chars <= max).map((rung) => rung.latencyMs)

			return { band, n: inBand.length, p50Ms: percentile(inBand, 50), p95Ms: percentile(inBand, 95) }
		}),
	}
}

/**
 * The human-readable report.
 */
export function printAutocompleteLadder(report: AutocompleteLadderReport): void {
	const headline = report.rows.filter((row) => row.headline).length

	console.log(
		`\nautocomplete ladder${report.country ? ` · ${report.country}` : ""} — ${report.rows.length} rows ` +
			`(${headline} headline, ${report.rows.length - headline} stratified out above ${HEADLINE_MAX_TOLERANCE_M / 1000} km), ` +
			`${report.excluded.length} excluded, top-${report.topK}`
	)

	console.log("\n  arm            rows  hit   median first-hit  churn  short rungs answered  full-string hits")

	for (const summary of report.summaries) {
		const fraction =
			summary.medianFirstHitFraction === null
				? "   —"
				: `${(summary.medianFirstHitFraction * 100).toFixed(0).padStart(3)}%`

		const without = summary.rowsWithoutArtifact
			? `  (${summary.rowsWithoutArtifact} rows without an FST for their country)`
			: ""

		console.log(
			`  ${summary.arm.padEnd(14)} ${String(summary.rows).padStart(4)}  ${String(summary.rowsHit).padStart(3)}   ${fraction} of chars      ` +
				`${String(summary.churnRows).padStart(5)}  ${String(summary.shortRungsAnswered).padStart(6)} of ${String(summary.shortRungs).padEnd(6)}   ${summary.fullStringHits}${without}`
		)
	}

	console.log("\n  latency (ms)   " + LADDER_LENGTH_BANDS.map(([band]) => band.padStart(14)).join(""))

	for (const summary of report.summaries) {
		console.log(
			`  ${summary.arm.padEnd(14)} ` +
				summary.latency
					.map((band) =>
						band.n === 0 ? "—".padStart(14) : `p50 ${band.p50Ms!.toFixed(0)} p95 ${band.p95Ms!.toFixed(0)}`.padStart(14)
					)
					.join("")
		)
	}

	if (report.disagreements.length) {
		console.log(`\n  arms disagree on the first-hit rung (${report.disagreements.length} rows):`)

		for (const row of report.disagreements.slice(0, 20)) {
			console.log(
				`    ${row.id.padEnd(44)} ${JSON.stringify(row.input)}  parse→resolve ${row.parse_resolve ?? "never"} · fst ${row.fst ?? "never"}`
			)
		}
	}

	console.log("")
}
