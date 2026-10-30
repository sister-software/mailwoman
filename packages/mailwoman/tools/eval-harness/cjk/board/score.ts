/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The pre-registered CJK board read: each row scored once and folded into the blended totals and two breakdowns.
 *
 *   The check is the blended fraction. The per-register split, the per-municipality macro and the gold-exact count are
 *   readings beside it and cannot move the check. `predict` is injected, so the scoring runs without a model.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { countInto } from "@mailwoman/core/stats"

import { boardArcKm, decodeAllSpans, normalizeCentroidKey } from "#tools/eval-harness/cjk/board/decode"

/**
 * The acceptability radius in kilometers.
 */
export const ACCEPT_KM = 15

/**
 * The blended fraction a board read must reach.
 */
export const CHECK = 0.7

/**
 * The two predicted tags concatenated into the centroid-table key, per label set.
 *
 * `stage3` maps prefecture to region and municipality to locality.
 * `stage3-jp` gives them their own tags, and the CJK head is `stage3-jp` plus `locality_unit`.
 */
export const RESOLVE_TAGS: Readonly<Record<string, readonly [string, string]>> = {
	stage3: ["region", "locality"],
	"stage3-jp": ["prefecture", "municipality"],
	"stage3-cjk": ["prefecture", "municipality"],
}

/**
 * One board row as the board JSONL stores it.
 */
export interface BoardRow {
	raw: string
	span_starts: number[]
	span_ends: number[]
	span_tags: string[]
	register?: string | null
	lon: number
	lat: number
	/**
	 * The JP board's kanji prefecture and municipality.
	 * The KR board stores them as `region` and `city`.
	 */
	pref?: string | null
	muni?: string | null
	region?: string | null
	city?: string | null
}

/**
 * A `(lon, lat)` centroid per normalized `region|locality` key.
 */
export type CentroidTable = Readonly<Record<string, readonly [number, number]>>

/**
 * One row's per-character label ids, at most one per code point.
 */
export type BoardPredictor = (raw: string) => readonly number[] | Promise<readonly number[]>

/**
 * One board row's result and the two keys that bucket it.
 *
 * `acceptable` and `unresolved` exclude each other.
 * A row in neither state resolved to a centroid outside the radius.
 *
 * `gold_exact` never implies `acceptable`, and the report states it beside the check.
 */
export interface RowResult {
	register: string | null
	goldMunicipality: string | null
	acceptable: boolean
	unresolved: boolean
	goldExact: boolean
	tagHits: string[]
	tagTotals: string[]
}

export interface ScoreRowOptions {
	labels: readonly string[]
	resolveTags: readonly [string, string]
	acceptKm?: number
}

/**
 * Scores one row's predicted labels: its centroid read, per-tag hits and buckets.
 */
export function scoreRow(
	row: BoardRow,
	labelIDs: readonly number[],
	centroids: CentroidTable,
	options: ScoreRowOptions
): RowResult {
	const acceptKm = options.acceptKm ?? ACCEPT_KM
	const [regionTag, localityTag] = options.resolveTags
	const codePoints = [...row.raw]
	const predicted = decodeAllSpans(row.raw, labelIDs.slice(0, codePoints.length), options.labels)
	const firstPredicted = (tag: string) => predicted.get(tag)?.[0]

	if (row.span_starts.length !== row.span_ends.length || row.span_starts.length !== row.span_tags.length) {
		throw new Error(`board row ${stringifyJSON(row.raw)}: span arrays differ in length`)
	}

	// A gold span hits when the model emitted that exact surface under that tag anywhere in the row.
	const goldSpans = row.span_tags.map(
		(tag, index) => [tag, codePoints.slice(row.span_starts[index], row.span_ends[index]).join("")] as const
	)

	const tagTotals = goldSpans.map(([tag]) => tag)
	const tagHits = goldSpans.filter(([tag, surface]) => predicted.get(tag)?.includes(surface)).map(([tag]) => tag)
	// The centroid read keys on the first span per tag on both sides.
	const gold = new Map<string, string>()

	for (const [tag, surface] of goldSpans) {
		if (!gold.has(tag)) {
			gold.set(tag, surface)
		}
	}

	const goldMunicipality = gold.get(localityTag) ?? null
	const key = normalizeCentroidKey(`${firstPredicted(regionTag) ?? ""}|${firstPredicted(localityTag) ?? ""}`)
	const hit = centroids[key]
	const acceptable = hit != null && boardArcKm(hit[0], hit[1], row.lon, row.lat) <= acceptKm
	let goldExact = false

	if (
		hit == null &&
		firstPredicted(regionTag) === gold.get(regionTag) &&
		firstPredicted(localityTag) === gold.get(localityTag)
	) {
		// A surface the kanji-keyed table cannot key (the kana register renders うんぜん市 for 雲仙市) is read
		// through the row's own kanji fields when the predicted pair equals the gold pair span for span.
		const goldKey = normalizeCentroidKey(`${row.pref || row.region || ""}|${row.muni || row.city || ""}`)
		const goldHit = centroids[goldKey]

		goldExact = goldHit != null && boardArcKm(goldHit[0], goldHit[1], row.lon, row.lat) <= acceptKm
	}

	return {
		register: row.register ?? null,
		goldMunicipality,
		acceptable,
		unresolved: hit == null,
		goldExact,
		tagHits,
		tagTotals,
	}
}

/**
 * Counts per register.
 */
export interface RegisterStats {
	rows: number
	acceptable: number
	unresolved: number
	gold_exact: number
	fraction: number
}

/**
 * Counts per held-out municipality.
 */
export interface MunicipalityStats {
	rows: number
	acceptable: number
	gold_exact: number
	fraction: number
}

/**
 * A board read's totals.
 *
 * Each map keeps the order in which its keys were first counted.
 */
export interface BoardResult {
	rows: number
	acceptable: number
	gold_exact_unresolved: number
	unresolved: number
	fraction: number
	tag_hit: Map<string, number>
	tag_total: Map<string, number>
	per_register: Map<string, RegisterStats>
	per_municipality: Map<string, MunicipalityStats>
	municipality_macro: number
}

/**
 * The blended totals and the two breakdowns, folded one row at a time.
 *
 * The board holds out whole municipalities, and one holds 823 of 20,000 rows,
 * so one name can move the row-weighted score by 2 percentage points.
 * The macro over municipalities is reported beside the blended fraction.
 */
export class BoardTallies {
	rows = 0
	acceptable = 0
	unresolved = 0
	goldExact = 0
	readonly tagHit = new Map<string, number>()
	readonly tagTotal = new Map<string, number>()
	readonly #registerRows = new Map<string, number>()
	readonly #registerAcceptable = new Map<string, number>()
	readonly #registerUnresolved = new Map<string, number>()
	readonly #registerGoldExact = new Map<string, number>()
	readonly #municipalityRows = new Map<string, number>()
	readonly #municipalityAcceptable = new Map<string, number>()
	readonly #municipalityGoldExact = new Map<string, number>()

	add(result: RowResult): void {
		const { register, goldMunicipality: municipality } = result

		this.rows++

		for (const tag of result.tagTotals) {
			countInto(this.tagTotal, tag)
		}

		for (const tag of result.tagHits) {
			countInto(this.tagHit, tag)
		}

		if (register !== null) {
			countInto(this.#registerRows, register)
		}

		if (municipality !== null) {
			countInto(this.#municipalityRows, municipality)
		}

		if (result.acceptable) {
			this.acceptable++

			if (register !== null) {
				countInto(this.#registerAcceptable, register)
			}

			if (municipality !== null) {
				countInto(this.#municipalityAcceptable, municipality)
			}
		}

		if (result.unresolved) {
			this.unresolved++

			if (register !== null) {
				countInto(this.#registerUnresolved, register)
			}
		}

		if (result.goldExact) {
			this.goldExact++

			if (register !== null) {
				countInto(this.#registerGoldExact, register)
			}

			if (municipality !== null) {
				countInto(this.#municipalityGoldExact, municipality)
			}
		}
	}

	report(): BoardResult {
		const count = (counts: Map<string, number>, name: string) => counts.get(name) ?? 0
		const perRegister = new Map<string, RegisterStats>()
		const perMunicipality = new Map<string, MunicipalityStats>()

		for (const [name, rows] of this.#registerRows) {
			perRegister.set(name, {
				rows,
				acceptable: count(this.#registerAcceptable, name),
				unresolved: count(this.#registerUnresolved, name),
				gold_exact: count(this.#registerGoldExact, name),
				fraction: count(this.#registerAcceptable, name) / rows,
			})
		}

		for (const [name, rows] of this.#municipalityRows) {
			perMunicipality.set(name, {
				rows,
				acceptable: count(this.#municipalityAcceptable, name),
				gold_exact: count(this.#municipalityGoldExact, name),
				fraction: count(this.#municipalityAcceptable, name) / rows,
			})
		}

		let fractionSum = 0

		for (const stats of perMunicipality.values()) {
			fractionSum += stats.fraction
		}

		return {
			rows: this.rows,
			acceptable: this.acceptable,
			gold_exact_unresolved: this.goldExact,
			unresolved: this.unresolved,
			fraction: this.rows ? this.acceptable / this.rows : 0,
			tag_hit: this.tagHit,
			tag_total: this.tagTotal,
			per_register: perRegister,
			per_municipality: perMunicipality,
			municipality_macro: perMunicipality.size ? fractionSum / perMunicipality.size : 0,
		}
	}
}

/**
 * Runs the pre-registered read over `rows`.
 *
 * The blended `fraction` is `acceptable / rows`, with an unresolved pair counted as unacceptable.
 */
export async function scoreBoard(
	rows: AsyncIterable<BoardRow> | Iterable<BoardRow>,
	predict: BoardPredictor,
	centroids: CentroidTable,
	options: ScoreRowOptions
): Promise<BoardResult> {
	const tallies = new BoardTallies()

	for await (const row of rows) {
		tallies.add(scoreRow(row, await predict(row.raw), centroids, options))
	}

	return tallies.report()
}
