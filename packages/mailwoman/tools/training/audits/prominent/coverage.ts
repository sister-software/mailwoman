// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The prominent-place coverage receipt, rule (a) of #3156: whether a corpus's
 *   train rows write each country's prominent places in their short query shapes,
 *   at a share that follows population, with coherent labels.
 *
 *   It reads the places table the prominent-places census writes
 *   (`places.parquet` and its `PLACES.json`, frozen per candidate-database build)
 *   and the corpus's short admin train rows.
 *   The census's `scanShortAdminRows` counts those rows.
 *   Three rules decide it:
 *
 *   1. **Presence.** Every required prominent place has a train row in each required shape,
 *      under the tag {@linkcode prominentPlaceTag} names.
 *      Every row belongs to an independent group, so a row is a group.
 *   2. **Demand share.** Per country, band and shape, decile 1's share of the train rows that
 *      write a ranked place under the expected tag is at least {@linkcode DEMAND_SHARE_FRACTION}
 *      of decile 1's share of the country's ranked-place population.
 *      A row whose surface several ranked places share counts once, toward the best-ranked one.
 *   3. **Label coherence.** No short admin train row writes a dependent locality without a locality.
 *
 *   A place is required when the selection rule picks it
 *   (`min(n, clamp(ceil(sqrt(n)), 5, 100))` per country and band, plus the national capital).
 *   A place whose score rests on a GeoNames population is required only when that
 *   match passed its checks (`geonames_check = 'verified'`).
 *
 *   Every threshold comes from the rule: presence is one row, the demand target is
 *   a population share from WOF and GeoNames, and the half follows the held-out
 *   span check's half-the-median convention (HOLDOUT §4.4).
 */

import { readLocalBuffer, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { sha256File, sha256Hex } from "@mailwoman/core/hash"
import { type DisposableDuckDB, type DuckDBLimits, escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import {
	PLACE_BANDS,
	prominentPlaceTag,
	type PlaceBand,
	QUERY_SHAPES,
	type QueryShape,
} from "@mailwoman/corpus/recipes/prominent/places"
import { foldSurfaceSQL } from "@mailwoman/corpus/tools/support-index"
import { PathBuilder } from "path-ts"

import type { ShortAdminScanRecord } from "#tools/dev-tools/corpus/prominent/places"

/**
 * The record the census's `places` writes beside `places.parquet`: the inputs it read
 * with their sha256s, the selection rule, and the scored and unscored counts.
 */
export const PROMINENT_PLACES_RECORD = "PLACES.json"

/**
 * Bumped when `places.parquet` gains, loses or redefines a column the receipt reads.
 */
export const PROMINENT_PLACES_RECORD_VERSION = 2

export interface ProminentPlacesRecord {
	version: number
	written_at: string
	candidate_db: string
	candidate_db_sha256: string
	geonames_postal: string
	geonames_postal_sha256: string
	geonames_admin1: string
	geonames_admin1_sha256: string
	geonames_glob: string
	places_sha256: string
	rule: { selection: string; geonames_match_km: number; capital_match_km: number }
	counts: Array<{ band: string; score_source: string; places: number; selected: number; geonames_verified: number }>
}

/**
 * The fraction of decile 1's population share that decile 1's row share must reach.
 */
export const DEMAND_SHARE_FRACTION = 0.5

/**
 * The GeoNames match distance bands the receipt samples accepted matches from, in kilometers.
 */
export const GEONAMES_AUDIT_BANDS_KM = [0, 2, 5, 10, 15] as const

/**
 * The accepted matches the receipt lists from each distance band.
 */
const GEONAMES_AUDIT_SAMPLE = 5

/**
 * The failing places and cells the report lists by name, after their counts.
 */
const LISTED_FAILURES = 200

function quoted(value: string): string {
	return `'${escapeSQLString(value)}'`
}

/**
 * The tag the receipt requires in each band and shape, as SQL rows `(band, shape, tag)`.
 * A deferred shape has no row.
 */
function requirementValuesSQL(): string {
	const rows = (Object.keys(PLACE_BANDS) as PlaceBand[]).flatMap((band) =>
		QUERY_SHAPES.map((shape) => [band, shape, prominentPlaceTag(band, shape)] as const).filter(
			(row): row is readonly [PlaceBand, QueryShape, "locality" | "dependent_locality"] => row[2] != null
		)
	)

	return rows.map(([band, shape, tag]) => `(${quoted(band)}, ${quoted(shape)}, ${quoted(tag)})`).join(", ")
}

/**
 * Reads the census's `PLACES.json` beside `placesPath` and checks it describes that file.
 *
 * @throws When the record is absent, of another version, or names another file's sha256.
 */
export async function readProminentPlacesRecord(placesPath: string): Promise<ProminentPlacesRecord> {
	const recordPath = placesRecordPath(placesPath)
	const record = await readLocalJSONFile<ProminentPlacesRecord>(recordPath)

	if (record.version !== PROMINENT_PLACES_RECORD_VERSION) {
		throw new Error(
			`${recordPath} is a version-${record.version} record; the receipt reads version ${PROMINENT_PLACES_RECORD_VERSION}`
		)
	}

	const actual = await sha256File(placesPath)

	if (actual !== record.places_sha256) {
		throw new Error(`${placesPath} has sha256 ${actual}, but ${recordPath} records ${record.places_sha256}`)
	}

	return record
}

/**
 * The digest of the `PLACES.json` beside `placesPath`, the line the preflight receipt key binds.
 */
export async function prominentPlacesRecordDigest(placesPath: string): Promise<string> {
	return sha256Hex(await readLocalBuffer(placesRecordPath(placesPath)))
}

function placesRecordPath(placesPath: string): string {
	return PathBuilder.from(placesPath).dirname()(PROMINENT_PLACES_RECORD).toString()
}

/**
 * Creates the receipt's tables in `db` from a places table and a short admin aggregate:
 *
 * - `ranked`: every ranked place, with `required` set on the places the rule requires.
 * - `forms`: one row per ranked place and shape the place has a second segment for,
 *   with the tag the shape requires.
 * - `hits`: the train rows of each form's surface key under its required tag.
 * - `cells`: per country, band and shape, the rows, decile 1's rows and decile 1's population share.
 */
export async function createProminentCoverageTables(
	db: DisposableDuckDB,
	placesPath: string,
	shortAdminPath: string
): Promise<void> {
	await db.run(
		`CREATE OR REPLACE TABLE ranked AS SELECT *, (by_rank OR capital) AND ` +
			"(score_source <> 'geonames' OR geonames_check = 'verified') AS required " +
			`FROM read_parquet(${quoted(placesPath)}) WHERE rank IS NOT NULL`
	)

	await db.run(
		`CREATE OR REPLACE TABLE agg AS SELECT *, string_split(shape, '|') AS tags FROM read_parquet(${quoted(shortAdminPath)})`
	)

	await db.run(`CREATE OR REPLACE TABLE requirements (band VARCHAR, query_shape VARCHAR, tag VARCHAR)`)

	await db.run(`INSERT INTO requirements VALUES ${requirementValuesSQL()}`)

	// The second segment's tag: the parent is a locality, a region or its abbreviation a region.
	await db.run(
		"CREATE OR REPLACE TABLE forms AS SELECT f.*, q.tag FROM (" +
			"SELECT spr_id, country, band, fold, decile, 'bare' AS query_shape, NULL::VARCHAR AS second, NULL::VARCHAR AS second_tag FROM ranked UNION ALL " +
			`SELECT spr_id, country, band, fold, decile, 'parent', ${foldSurfaceSQL("parent_locality")}, 'locality' FROM ranked WHERE parent_locality IS NOT NULL UNION ALL ` +
			`SELECT spr_id, country, band, fold, decile, 'region', ${foldSurfaceSQL("region")}, 'region' FROM ranked WHERE region IS NOT NULL UNION ALL ` +
			`SELECT spr_id, country, band, fold, decile, 'region_abbr', ${foldSurfaceSQL("abbr")}, 'region' FROM ` +
			"(SELECT spr_id, country, band, fold, decile, unnest(region_abbrs) AS abbr FROM ranked) UNION ALL " +
			"SELECT spr_id, country, band, fold, decile, 'country', NULL, 'country' FROM ranked" +
			") f JOIN requirements q ON q.band = f.band AND q.query_shape = f.query_shape"
	)

	// The place's own span is the dependent locality when the row writes one, else the locality,
	// in either position: a largest-first layout writes `Iran, Tehran` and `東京都渋谷区`.
	await db.run(
		"CREATE OR REPLACE TABLE keyed AS SELECT country, " +
			"CASE WHEN place = 1 THEN s1 ELSE s2 END AS s1, CASE WHEN len(tags) = 1 THEN NULL WHEN place = 1 THEN s2 ELSE s1 END AS s2, " +
			"CASE WHEN len(tags) = 1 THEN 'bare' ELSE tags[3 - place] END AS second_tag, " +
			"tags[place] AS place_tag, sum(rows)::BIGINT AS rows FROM (" +
			"SELECT *, CASE WHEN list_contains(tags, 'dependent_locality') THEN list_position(tags, 'dependent_locality') " +
			"WHEN list_contains(tags, 'locality') THEN list_position(tags, 'locality') ELSE 1 END AS place FROM agg WHERE len(tags) <= 2" +
			") GROUP BY ALL"
	)

	// A form's rows: the short rows of its surfaces whose own span holds the required tag.
	await db.run(
		"CREATE OR REPLACE TABLE hits AS SELECT f.spr_id, f.country, f.band, f.query_shape, f.decile, f.fold, f.second, " +
			"coalesce(sum(k.rows), 0)::BIGINT AS rows FROM forms f LEFT JOIN keyed k ON k.country = f.country AND " +
			"k.s1 = f.fold AND k.place_tag = f.tag AND (" +
			"(f.query_shape = 'bare' AND k.second_tag = 'bare') OR (f.query_shape = 'country' AND k.second_tag = 'country') OR " +
			"(f.query_shape IN ('parent', 'region', 'region_abbr') AND k.second_tag = f.second_tag AND k.s2 = f.second)) " +
			"GROUP BY ALL"
	)

	// A place with several region abbreviations is covered in that shape by a row in any of them.
	await db.run(
		"CREATE OR REPLACE TABLE place_shapes AS SELECT spr_id, country, band, query_shape, sum(rows)::BIGINT AS rows " +
			"FROM hits GROUP BY ALL"
	)

	// Each surface key counts once in its cell, toward the best decile among the ranked places that write it.
	await db.run(
		"CREATE OR REPLACE TABLE surface_rows AS SELECT country, band, query_shape, fold, second, " +
			"min(decile) AS decile, any_value(rows) AS rows FROM hits GROUP BY ALL"
	)

	await db.run(
		"CREATE OR REPLACE TABLE population AS SELECT country, band, " +
			"sum(population_used) FILTER (WHERE decile = 1) / nullif(sum(population_used), 0) AS decile1_population_share " +
			"FROM ranked WHERE population_used > 0 GROUP BY ALL"
	)

	await db.run(
		"CREATE OR REPLACE TABLE cells AS SELECT s.country, s.band, s.query_shape, sum(s.rows)::BIGINT AS rows, " +
			"coalesce(sum(s.rows) FILTER (WHERE s.decile = 1), 0)::BIGINT AS decile1_rows, p.decile1_population_share " +
			"FROM surface_rows s JOIN (SELECT DISTINCT f.country, f.band, f.query_shape FROM forms f " +
			"JOIN ranked r USING (spr_id) WHERE r.required) c USING (country, band, query_shape) " +
			"LEFT JOIN population p USING (country, band) GROUP BY s.country, s.band, s.query_shape, p.decile1_population_share"
	)
}

/**
 * The rows decile 1 lacks in one cell for its share to reach the target: the smallest `d`
 * with `(decile1 + d) / (rows + d) >= target`, or 0 when the cell already reaches it.
 *
 * Rows added for decile-1 places raise both counts.
 * The gap is therefore larger than `target × rows − decile1`.
 */
export function decileOneDeficit(rows: number, decile1Rows: number, target: number): number {
	if (target <= 0) return 0

	if (target >= 1) throw new Error(`a demand target of ${target} can't be reached by adding rows`)

	return Math.max(0, Math.ceil((target * rows - decile1Rows) / (1 - target) - 1e-9))
}

export interface ProminentCoverageReport {
	receipt: "prominent_place_coverage"
	passed: boolean
	places: string
	places_record: Pick<
		ProminentPlacesRecord,
		"candidate_db" | "candidate_db_sha256" | "places_sha256" | "rule" | "counts"
	>
	corpus: ShortAdminScanRecord
	presence: {
		required_places: number
		required_forms: number
		covered_forms: number
		/**
		 * Selected places that aren't required, by why: a GeoNames match that failed a check.
		 */
		not_required: Record<string, number>
		failing_by_band_shape: Array<{ band: string; query_shape: string; forms: number; failing: number }>
		failing: Array<{ country: string; band: string; query_shape: string; spr_id: number; name: string }>
	}
	demand_share: {
		fraction_of_population_share: number
		cells: number
		passing: number
		cells_without_population: number
		by_band_shape: Array<{ band: string; query_shape: string; cells: number; passing: number }>
		failing: Array<{
			country: string
			band: string
			query_shape: string
			rows: number
			decile1_rows: number
			decile1_row_share: number
			target: number
			deficit: number
		}>
	}
	coherence: { rows: number; by_source: Array<{ source: string; shape: string; rows: number }> }
	geonames_audit: Array<{
		band_km: string
		accepted: number
		sample: Array<{
			spr_id: number
			country: string
			band: string
			name: string
			region: string
			geonames_id: string
			km: number
			population: number
		}>
	}>
}

/**
 * One DuckDB result row, read field by field into the types the receipt reports.
 */
export interface ResultRow {
	text(key: string): string
	optionalText(key: string): string | null
	number(key: string): number
	optionalNumber(key: string): number | null
	textList(key: string): string[]
}

/**
 * Runs `sql` and projects each result row through `project`.
 */
export async function queryRows<T>(db: DisposableDuckDB, sql: string, project: (row: ResultRow) => T): Promise<T[]> {
	return (await db.runAndReadAll(sql)).getRowObjectsJson().map((values) =>
		project({
			text: (key) => String(values[key] ?? ""),
			optionalText: (key) => (values[key] == null ? null : String(values[key])),
			number: (key) => Number(values[key] ?? 0),
			optionalNumber: (key) => (values[key] == null ? null : Number(values[key])),
			textList: (key) => {
				const value = values[key]

				return Array.isArray(value) ? value.map((item: unknown) => String(item)) : []
			},
		})
	)
}

/**
 * The cells {@linkcode createProminentCoverageTables} wrote, with their demand-share rows.
 */
export interface DemandCell {
	country: string
	band: string
	query_shape: string
	rows: number
	decile1_rows: number
	decile1_population_share: number | null
}

/**
 * Reads the `cells` table.
 */
export function readDemandCells(db: DisposableDuckDB): Promise<DemandCell[]> {
	return queryRows(db, "SELECT * FROM cells ORDER BY country, band, query_shape", (row) => ({
		country: row.text("country"),
		band: row.text("band"),
		query_shape: row.text("query_shape"),
		rows: row.number("rows"),
		decile1_rows: row.number("decile1_rows"),
		decile1_population_share: row.optionalNumber("decile1_population_share"),
	}))
}

/**
 * The three rules over tables {@linkcode createProminentCoverageTables} made.
 */
export async function evaluateProminentCoverage(
	db: DisposableDuckDB
): Promise<Pick<ProminentCoverageReport, "presence" | "demand_share" | "coherence" | "geonames_audit">> {
	const [presenceTotals] = await queryRows(
		db,
		"SELECT count(DISTINCT h.spr_id)::INTEGER AS places, count(*)::INTEGER AS forms, " +
			"count(*) FILTER (WHERE h.rows > 0)::INTEGER AS covered FROM place_shapes h JOIN ranked r USING (spr_id) WHERE r.required",
		(row) => ({ places: row.number("places"), forms: row.number("forms"), covered: row.number("covered") })
	)

	const notRequired = await queryRows(
		db,
		"SELECT coalesce(geonames_check, 'unchecked') AS reason, count(*)::INTEGER AS places FROM ranked " +
			"WHERE (by_rank OR capital) AND NOT required GROUP BY ALL ORDER BY reason",
		(row) => [row.text("reason"), row.number("places")] as const
	)

	const failingByShape = await queryRows(
		db,
		"SELECT h.band, h.query_shape, count(*)::INTEGER AS forms, count(*) FILTER (WHERE h.rows = 0)::INTEGER AS failing " +
			"FROM place_shapes h JOIN ranked r USING (spr_id) WHERE r.required GROUP BY ALL ORDER BY h.band, h.query_shape",
		(row) => ({
			band: row.text("band"),
			query_shape: row.text("query_shape"),
			forms: row.number("forms"),
			failing: row.number("failing"),
		})
	)

	const failingPlaces = await queryRows(
		db,
		"SELECT h.country, h.band, h.query_shape, h.spr_id, r.name FROM place_shapes h JOIN ranked r USING (spr_id) " +
			`WHERE r.required AND h.rows = 0 ORDER BY r.rank, h.country, h.band, h.query_shape LIMIT ${LISTED_FAILURES}`,
		(row) => ({
			country: row.text("country"),
			band: row.text("band"),
			query_shape: row.text("query_shape"),
			spr_id: row.number("spr_id"),
			name: row.text("name"),
		})
	)

	const judged = (await readDemandCells(db)).map((cell) => {
		const target = cell.decile1_population_share == null ? null : DEMAND_SHARE_FRACTION * cell.decile1_population_share
		const share = cell.rows ? cell.decile1_rows / cell.rows : 0

		return { ...cell, share, target, passed: target == null || (cell.rows > 0 && share >= target) }
	})

	const shapes = new Map<string, { band: string; query_shape: string; cells: number; passing: number }>()

	for (const cell of judged) {
		const key = `${cell.band}\u0000${cell.query_shape}`
		const entry = shapes.get(key) ?? { band: cell.band, query_shape: cell.query_shape, cells: 0, passing: 0 }

		entry.cells++
		entry.passing += cell.passed ? 1 : 0
		shapes.set(key, entry)
	}

	const coherence = await queryRows(
		db,
		"SELECT source, shape, sum(rows)::BIGINT AS rows FROM agg WHERE list_contains(tags, 'dependent_locality') " +
			"AND NOT list_contains(tags, 'locality') GROUP BY ALL ORDER BY rows DESC",
		(row) => ({ source: row.text("source"), shape: row.text("shape"), rows: row.number("rows") })
	)

	const bands = GEONAMES_AUDIT_BANDS_KM.slice(1).map(
		(upper, index) => [GEONAMES_AUDIT_BANDS_KM[index]!, upper] as const
	)

	const geonamesAudit: ProminentCoverageReport["geonames_audit"] = []

	for (const [lower, upper] of bands) {
		const where =
			`required AND score_source = 'geonames' AND geonames_km >= ${lower} AND geonames_km ` +
			(upper === GEONAMES_AUDIT_BANDS_KM.at(-1) ? `<= ${upper}` : `< ${upper}`)

		const [accepted] = await queryRows(db, `SELECT count(*)::INTEGER AS n FROM ranked WHERE ${where}`, (row) =>
			row.number("n")
		)

		const sample = await queryRows(
			db,
			"SELECT spr_id, country, band, name, region, geonames_id, round(geonames_km, 2) AS km, population_used " +
				`FROM ranked WHERE ${where} ORDER BY hash(spr_id) LIMIT ${GEONAMES_AUDIT_SAMPLE}`,
			(row) => ({
				spr_id: row.number("spr_id"),
				country: row.text("country"),
				band: row.text("band"),
				name: row.text("name"),
				region: row.text("region"),
				geonames_id: row.text("geonames_id"),
				km: row.number("km"),
				population: row.number("population_used"),
			})
		)

		geonamesAudit.push({ band_km: `${lower}-${upper}`, accepted: accepted ?? 0, sample })
	}

	const failingCells = judged.filter((cell) => !cell.passed)

	return {
		presence: {
			required_places: presenceTotals?.places ?? 0,
			required_forms: presenceTotals?.forms ?? 0,
			covered_forms: presenceTotals?.covered ?? 0,
			not_required: Object.fromEntries(notRequired),
			failing_by_band_shape: failingByShape,
			failing: failingPlaces,
		},
		demand_share: {
			fraction_of_population_share: DEMAND_SHARE_FRACTION,
			cells: judged.length,
			passing: judged.filter((cell) => cell.passed).length,
			cells_without_population: judged.filter((cell) => cell.target == null).length,
			by_band_shape: [...shapes.values()],
			failing: failingCells.slice(0, LISTED_FAILURES).map((cell) => ({
				country: cell.country,
				band: cell.band,
				query_shape: cell.query_shape,
				rows: cell.rows,
				decile1_rows: cell.decile1_rows,
				decile1_row_share: cell.share,
				target: cell.target!,
				deficit: decileOneDeficit(cell.rows, cell.decile1_rows, cell.target!),
			})),
		},
		coherence: {
			rows: coherence.reduce((sum, row) => sum + row.rows, 0),
			by_source: coherence,
		},
		geonames_audit: geonamesAudit,
	}
}

export interface ProminentCoverageOptions {
	/**
	 * The census's `places.parquet`, with its `PLACES.json` beside it.
	 */
	places: string
	/**
	 * The corpus `MANIFEST.json` whose train rows the receipt reads.
	 */
	manifest: string
	limits?: DuckDBLimits
	log?: (line: string) => void
}

/**
 * Runs the receipt: scans the corpus's short admin train rows and applies the three rules.
 */
export async function prominentCoverageReport(options: ProminentCoverageOptions): Promise<ProminentCoverageReport> {
	const record = await readProminentPlacesRecord(options.places)

	await using scratch = await temporaryDirectory("mailwoman-prominent-coverage-")

	// The census module reads the candidate database through `node:sqlite`.
	// The rules need neither.
	const { scanShortAdminRows } = await import("#tools/dev-tools/corpus/prominent/places")

	const corpus = await scanShortAdminRows({
		manifest: options.manifest,
		out: scratch.path.toString(),
		limits: options.limits,
		log: options.log,
	})

	using db = await openDuckDB(options.limits)

	await createProminentCoverageTables(db, options.places, scratch.path("short-admin-rows.parquet").toString())

	const rules = await evaluateProminentCoverage(db)

	const passed =
		rules.presence.covered_forms === rules.presence.required_forms &&
		rules.demand_share.passing === rules.demand_share.cells &&
		rules.coherence.rows === 0

	return {
		receipt: "prominent_place_coverage",
		passed,
		places: options.places,
		places_record: {
			candidate_db: record.candidate_db,
			candidate_db_sha256: record.candidate_db_sha256,
			places_sha256: record.places_sha256,
			rule: record.rule,
			counts: record.counts,
		},
		corpus,
		...rules,
	}
}
