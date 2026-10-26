/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A corpus's train-split shapes and surfaces, counted once beside its manifest and queried per gauntlet row.
 *
 *   Whether a corpus supported a row used to take a scan of every train row, about 8 minutes per 700 M-row
 *   corpus, through a reader written for the question. This index answers the three questions that scan
 *   answered: the train rows of a country that hold a given set of component tags, the rows that hold a
 *   surface under each tag, and the rows that hold a word at the head or tail of an open-class span.
 *
 *   Rows are attributed to the train split the way `countHoldoutSpans` attributes them, with the manifest's
 *   deletions removed, so a count here is a count the trainer read.
 */

import { COMPONENT_TAGS, type ComponentTag } from "@mailwoman/codex/component"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import { dirname, resolvePath } from "path-ts"

import { type DisposableDuckDB, type DuckDBLimits, escapeSQLString, openDuckDB } from "#parquet/duckdb"
import { type CorpusDeletion, deletionTargets, readDeletionIDs } from "#tools/overlay/deletions"
import { baseManifestFiles, localManifestFilePath } from "#tools/overlay/manifest"
import { readSplitAttribute } from "#tools/overlay/split-attribute"

/**
 * The directory beside a manifest that holds its support index.
 */
export const SUPPORT_INDEX_DIRECTORY = "support-index"

/**
 * The record a finished index writes last, so its presence marks the index complete.
 */
export const SUPPORT_INDEX_RECORD = "SUPPORT_INDEX.json"

/**
 * The record's layout version, raised when a column or a fold changes meaning.
 */
export const SUPPORT_INDEX_VERSION = 1

const SHAPES_FILE = "shapes.parquet"
const SURFACES_FILE = "surfaces.parquet"

/**
 * The tags whose span comes from a bounded vocabulary, indexed by whole folded surface.
 */
export const CLOSED_CLASS_TAGS: readonly ComponentTag[] = [
	"country",
	"region",
	"subregion",
	"locality",
	"dependent_locality",
	"postcode",
	"street_prefix",
	"street_prefix_particle",
	"street_suffix",
	"po_box",
	"cedex",
	"prefecture",
	"municipality",
	"district",
	"locality_unit",
]

/**
 * The tags whose span is open vocabulary, indexed by the folded first and last word.
 *
 * A whole venue or street name would make the surface table as large as the corpus.
 */
export const OPEN_CLASS_TAGS: readonly ComponentTag[] = [
	"house_number",
	"street",
	"intersection_a",
	"intersection_b",
	"unit",
	"venue",
	"attention",
	"block",
	"sub_block",
	"building_number",
	"building_name",
]

/**
 * Every component tag belongs to one class.
 *
 * A tag added to the vocabulary without a class would be left out of the index without a trace.
 */
export function unclassifiedTags(): ComponentTag[] {
	const classified = new Set<string>([...CLOSED_CLASS_TAGS, ...OPEN_CLASS_TAGS])

	return COMPONENT_TAGS.filter((tag) => !classified.has(tag))
}

/**
 * The fold applied to every indexed surface and to every queried value.
 *
 * It runs in SQL so the index and the query share one implementation.
 * DuckDB folds canonical forms (NFC) rather than compatibility forms, so a fullwidth
 * letter stays distinct from its ASCII form here.
 */
export function foldSurfaceSQL(expression: string): string {
	return `lower(trim(regexp_replace(nfc_normalize(${expression}), '\\s+', ' ', 'g')))`
}

/**
 * How a span's surface entered the index: whole, or by its first or last word.
 */
export type SurfacePosition = "whole" | "first" | "last"

/**
 * What a finished index records about itself.
 */
export interface SupportIndexRecord {
	version: number
	manifest: string
	corpus_version: string | null
	taken_at: string
	elapsed_ms: number
	files_listed: number
	files_read: number
	/**
	 * Files the manifest records as `val` or `test`, read by no train row.
	 */
	files_held_out: number
	train_rows: number
	fold: string
	closed_class_tags: string[]
	open_class_tags: string[]
	shapes_file: string
	surfaces_file: string
	shape_entries: number
	surface_entries: number
}

export interface BuildSupportIndexOptions {
	/**
	 * Where the index is written.
	 *
	 * @defaultValue `support-index` beside the manifest.
	 */
	outDir?: string
	/**
	 * Stop after N train files have been read, for a smoke run.
	 *
	 * Held-out files are skipped without counting, and the record states the number of files read.
	 */
	limitFiles?: number
	limits?: DuckDBLimits
	log?: (line: string) => void
}

/**
 * The index directory for a manifest.
 */
export function supportIndexDirectoryFor(manifestPath: string): string {
	return resolvePath(dirname(manifestPath), SUPPORT_INDEX_DIRECTORY).toString()
}

/**
 * The record of a finished index, or `null` when the directory holds none.
 */
export async function readSupportIndexRecord(indexDir: string): Promise<SupportIndexRecord | null> {
	const recordPath = resolvePath(indexDir, SUPPORT_INDEX_RECORD)

	if (!(await pathExists(recordPath))) return null

	return readLocalJSONFile<SupportIndexRecord>(recordPath)
}

function quoted(value: string): string {
	return `'${escapeSQLString(value)}'`
}

function tagList(tags: readonly string[]): string {
	return tags.map(quoted).join(", ")
}

async function deletionIDs(deletion: CorpusDeletion, limits?: DuckDBLimits): Promise<Iterable<string>> {
	if (deletion.source_ids) return deletion.source_ids

	if (deletion.source_ids_file) return readDeletionIDs(localManifestFilePath(deletion.source_ids_file.path), limits)

	throw new Error(`manifest deletion ${deletion.issue} lists neither source_ids nor source_ids_file`)
}

async function appendIDs(db: DisposableDuckDB, table: string, ids: Iterable<string>): Promise<void> {
	const appender = await db.createAppender(table)

	for (const id of ids) {
		appender.appendVarchar(id)
		appender.endRow()
	}

	appender.closeSync()
}

/**
 * The train files read between two merges of the per-file aggregates.
 *
 * Each file appends its own groups, so without a merge the tables grow with the file count
 * rather than with the number of distinct surfaces.
 */
const MERGE_EVERY_FILES = 25

async function mergeAggregates(db: DisposableDuckDB): Promise<void> {
	await db.run(
		"CREATE TEMP TABLE shapes_merged AS SELECT country, source, shape, tag_set, sum(n)::BIGINT AS n FROM shapes GROUP BY ALL"
	)

	await db.run("DROP TABLE shapes")
	await db.run("ALTER TABLE shapes_merged RENAME TO shapes")

	await db.run(
		"CREATE TEMP TABLE surfaces_merged AS SELECT country, tag, position, surface, sum(n)::BIGINT AS n FROM surfaces GROUP BY ALL"
	)

	await db.run("DROP TABLE surfaces")
	await db.run("ALTER TABLE surfaces_merged RENAME TO surfaces")
}

async function countOf(db: DisposableDuckDB, sql: string): Promise<number> {
	const row = (await db.runAndReadAll(sql)).getRowObjectsJson()[0] as { n: string | number } | undefined

	return Number(row?.n ?? 0)
}

/**
 * The surface rows one file contributes: whole folded surfaces for closed-class spans,
 * and the folded first and last word for open-class spans.
 *
 * A row holding one (tag, text) pair twice contributes it once, so the counts are rows.
 */
function surfaceSelect(): string {
	const text = "split_part(s, chr(0), 2)"
	const firstWord = `regexp_extract(${text}, '^\\s*(\\S+)', 1)`
	const lastWord = `regexp_extract(${text}, '(\\S+)\\s*$', 1)`

	return (
		`WITH spans AS (SELECT country, split_part(s, chr(0), 1) AS tag, s FROM r, unnest(spans) AS t(s)) ` +
		`SELECT country, tag, 'whole' AS position, ${foldSurfaceSQL(text)} AS surface, count(*) AS n FROM spans ` +
		`WHERE tag IN (${tagList(CLOSED_CLASS_TAGS)}) GROUP BY ALL ` +
		`UNION ALL SELECT country, tag, 'first', ${foldSurfaceSQL(firstWord)}, count(*) FROM spans ` +
		`WHERE tag IN (${tagList(OPEN_CLASS_TAGS)}) GROUP BY ALL ` +
		`UNION ALL SELECT country, tag, 'last', ${foldSurfaceSQL(lastWord)}, count(*) FROM spans ` +
		`WHERE tag IN (${tagList(OPEN_CLASS_TAGS)}) GROUP BY ALL`
	)
}

/**
 * Count a corpus's train-split shapes and surfaces and write them beside its manifest.
 *
 * Each manifest file is read once through DuckDB.
 * A file recorded as `val` or `test` is skipped.
 *
 * A file decided by a split attribute contributes the rows the attribute lists under
 * neither held-out split, and a file a manifest deletion targets loses the deleted ids.
 *
 * @throws When a manifest file records neither a split nor a split attribute,
 * since reading it as train or skipping it would both misstate the count.
 */
export async function buildSupportIndex(
	manifestPath: string,
	options: BuildSupportIndexOptions = {}
): Promise<SupportIndexRecord> {
	const startedAt = Date.now()

	const manifest = await readLocalJSONFile<{
		corpus_version?: string
		deletions?: CorpusDeletion[]
		files?: unknown
	}>(manifestPath)

	const files = baseManifestFiles(manifest)
	const outDir = options.outDir ?? supportIndexDirectoryFor(manifestPath)
	const deletions = manifest.deletions ?? []

	await makeDirectories(outDir)

	using db = await openDuckDB(options.limits)

	await db.run("CREATE TEMP TABLE excluded_ids (id VARCHAR)")
	await db.run("CREATE TEMP TABLE shapes (country VARCHAR, source VARCHAR, shape VARCHAR, tag_set VARCHAR, n BIGINT)")

	await db.run("CREATE TEMP TABLE surfaces (country VARCHAR, tag VARCHAR, position VARCHAR, surface VARCHAR, n BIGINT)")

	let filesRead = 0
	let filesHeldOut = 0
	let trainRows = 0

	for (const [index, file] of files.entries()) {
		if (options.limitFiles && filesRead >= options.limitFiles) break

		const split = file["split"]
		const reference = file["split_attribute"] as { path?: unknown } | undefined

		if (split !== "train" && split !== "val" && split !== "test" && typeof reference?.path !== "string") {
			throw new Error(`${manifestPath} lists ${file.path} with neither a split nor a split attribute`)
		}

		if (split === "val" || split === "test") {
			filesHeldOut++

			continue
		}

		const excluded = new Set<string>()

		if (typeof split !== "string") {
			const attribute = await readSplitAttribute(localManifestFilePath(reference!.path as string))

			for (const id of [...attribute.val, ...attribute.test]) {
				excluded.add(id)
			}
		}

		for (const deletion of deletions) {
			if (!deletionTargets(deletion.target, file)) continue

			for (const id of await deletionIDs(deletion, options.limits)) {
				excluded.add(id)
			}
		}

		await db.run("DELETE FROM excluded_ids")

		if (excluded.size) {
			await appendIDs(db, "excluded_ids", excluded)
		}

		const predicate = excluded.size ? "source_id NOT IN (SELECT id FROM excluded_ids)" : "true"
		const path = localManifestFilePath(file.path)

		await db.run(
			`CREATE OR REPLACE TEMP TABLE r AS SELECT country, source, span_tags, ` +
				`list_distinct([span_tags[i] || chr(0) || substr(raw, span_starts[i] + 1, span_ends[i] - span_starts[i]) ` +
				`FOR i IN range(1, len(span_tags) + 1)]) AS spans ` +
				`FROM read_parquet(${quoted(path)}) WHERE ${predicate}`
		)

		const rows = await countOf(db, "SELECT count(*)::BIGINT AS n FROM r")

		trainRows += rows

		await db.run(
			"INSERT INTO shapes SELECT country, source, array_to_string(span_tags, '|'), " +
				"array_to_string(list_sort(list_distinct(span_tags)), '|'), count(*) FROM r GROUP BY ALL"
		)

		await db.run(`INSERT INTO surfaces ${surfaceSelect()}`)

		filesRead++

		options.log?.(
			`[support-index] ${index + 1}/${files.length} ${path}: ${rows} train rows, ` +
				`${Math.round((Date.now() - startedAt) / 1000)}s elapsed`
		)

		if (filesRead % MERGE_EVERY_FILES === 0) {
			await mergeAggregates(db)
		}
	}

	const shapesPath = resolvePath(outDir, SHAPES_FILE).toString()
	const surfacesPath = resolvePath(outDir, SURFACES_FILE).toString()

	await db.run(
		"COPY (SELECT country, source, shape, tag_set, sum(n)::BIGINT AS rows FROM shapes GROUP BY ALL " +
			`ORDER BY country, tag_set, shape, source) TO ${quoted(shapesPath)} (FORMAT PARQUET)`
	)

	await db.run(
		"COPY (SELECT country, tag, position, surface, sum(n)::BIGINT AS rows FROM surfaces GROUP BY ALL " +
			`ORDER BY country, tag, position, surface) TO ${quoted(surfacesPath)} (FORMAT PARQUET)`
	)

	const record: SupportIndexRecord = {
		version: SUPPORT_INDEX_VERSION,
		manifest: manifestPath,
		corpus_version: manifest.corpus_version ?? null,
		taken_at: new Date().toISOString(),
		elapsed_ms: Date.now() - startedAt,
		files_listed: files.length,
		files_read: filesRead,
		files_held_out: filesHeldOut,
		train_rows: trainRows,
		fold: foldSurfaceSQL("surface"),
		closed_class_tags: [...CLOSED_CLASS_TAGS],
		open_class_tags: [...OPEN_CLASS_TAGS],
		shapes_file: SHAPES_FILE,
		surfaces_file: SURFACES_FILE,
		shape_entries: await countOf(db, `SELECT count(*)::BIGINT AS n FROM read_parquet(${quoted(shapesPath)})`),
		surface_entries: await countOf(db, `SELECT count(*)::BIGINT AS n FROM read_parquet(${quoted(surfacesPath)})`),
	}

	await writeLocalJSONFile(record, resolvePath(outDir, SUPPORT_INDEX_RECORD))

	return record
}

// #region Query

/**
 * One row to read support for: its country and the components it expects.
 */
export interface SupportQueryRow {
	id: string
	country: string | null
	components: Readonly<Record<string, string>>
}

/**
 * One word of an open-class value and the (tag, position) entries that hold it.
 *
 * A key is the tag for a whole-surface entry and `tag/position` for a head or tail entry.
 */
export interface WordSupport {
	position: "first" | "last"
	word: string
	under: Record<string, number>
}

/**
 * The train support for one expected component.
 *
 * - `closed`: `own_rows` is the rows holding the folded value under the expected tag,
 *   and `under_tags` the rows holding it under every tag.
 * - `open`: the value is read by its first and last word in `words`, and `own_rows` is `null`.
 * - `unindexed`: the tag belongs to neither class, so the reading is empty rather than zero.
 */
export interface ComponentSupport {
	tag: string
	value: string
	kind: "closed" | "open" | "unindexed"
	own_rows: number | null
	under_tags: Record<string, number>
	words: WordSupport[]
}

export interface SupportRowReading {
	id: string
	country: string | null
	/**
	 * The row's expected tags, sorted and joined with `|`, which is how the index keys a shape.
	 */
	tag_set: string
	/**
	 * Train rows of the country whose tag set is exactly `tag_set`, or `null`
	 * when the row states no country and could not be probed.
	 */
	shape_rows: number | null
	shape_sources: Array<{ source: string; rows: number }>
	components: ComponentSupport[]
	rendered: string
}

const WORD_POSITIONS = ["first", "last"] as const

function tagSetOf(components: Readonly<Record<string, string>>): string {
	return [...new Set(Object.keys(components))].toSorted().join("|")
}

function classOf(tag: string): ComponentSupport["kind"] {
	if ((CLOSED_CLASS_TAGS as readonly string[]).includes(tag)) return "closed"

	if ((OPEN_CLASS_TAGS as readonly string[]).includes(tag)) return "open"

	return "unindexed"
}

/**
 * The first and last whitespace-delimited word of an open-class value, the two positions the index holds.
 */
function headAndTailWords(value: string): Array<{ position: "first" | "last"; word: string }> {
	const words = value.trim().split(/\s+/u).filter(isPresent)

	if (!words.length) return []

	return WORD_POSITIONS.map((position) => ({ position, word: position === "first" ? words[0]! : words.at(-1)! }))
}

interface SurfaceProbe {
	rowIndex: number
	componentIndex: number
	position: "whole" | "first" | "last"
	country: string
	raw: string
}

/**
 * Renders one row's support on one line, for a transcript a human reads without a paraphrase.
 */
export function renderSupportRow(row: Omit<SupportRowReading, "rendered">): string {
	const shape =
		row.shape_rows === null
			? `${row.tag_set || "(no components)"} rows unread (no country)`
			: `${row.tag_set || "(no components)"} rows ${row.shape_rows}` +
				(row.shape_sources.length
					? ` (${row.shape_sources
							.slice(0, 3)
							.map((entry) => `${entry.source} ${entry.rows}`)
							.join(", ")})`
					: "")

	const components = row.components.map((component) => {
		const head = `${component.tag} ${stringifyJSON(component.value)}`

		if (component.kind === "unindexed") return `${head}: tag unindexed`

		if (component.kind === "closed") {
			const others = Object.entries(component.under_tags)
				.filter(([tag]) => tag !== component.tag)
				.toSorted(([, a], [, b]) => b - a)
				.map(([tag, rows]) => `${tag} ${rows}`)

			return `${head}: ${component.tag} ${component.own_rows ?? 0}${others.length ? `, ${others.join(", ")}` : ""}`
		}

		const words = component.words.map((word) => {
			const under = Object.entries(word.under)
				.toSorted(([, a], [, b]) => b - a)
				.map(([key, rows]) => `${key} ${rows}`)
				.join(", ")

			return `${word.position} ${stringifyJSON(word.word)} → ${under || "0"}`
		})

		return `${head}: ${words.join("; ") || "no words"}`
	})

	return [`${row.id} · ${row.country ?? "??"} ${shape}`, ...components].join(" · ")
}

/**
 * Read the train support of each row from a finished index.
 *
 * Every probe is folded by the index's own SQL fold and joined in one pass per table,
 * so a board of a thousand rows is two scans rather than thousands.
 *
 * @throws When the directory holds no finished record.
 */
export async function querySupport(
	indexDir: string,
	rows: readonly SupportQueryRow[],
	limits?: DuckDBLimits
): Promise<SupportRowReading[]> {
	const record = await readSupportIndexRecord(indexDir)

	if (!record) {
		throw new Error(`${indexDir} holds no ${SUPPORT_INDEX_RECORD}; build the index before querying it.`)
	}

	const shapesPath = resolvePath(indexDir, record.shapes_file).toString()
	const surfacesPath = resolvePath(indexDir, record.surfaces_file).toString()

	const readings: Array<Omit<SupportRowReading, "rendered">> = rows.map((row) => ({
		id: row.id,
		country: row.country ? row.country.toUpperCase() : null,
		tag_set: tagSetOf(row.components),
		shape_rows: row.country ? 0 : null,
		shape_sources: [],
		components: Object.entries(row.components).map(([tag, value]) => ({
			tag,
			value,
			kind: classOf(tag),
			own_rows: classOf(tag) === "closed" ? 0 : null,
			under_tags: {},
			words: classOf(tag) === "open" ? headAndTailWords(value).map((word) => ({ ...word, under: {} })) : [],
		})),
	}))

	const probes: SurfaceProbe[] = []

	for (const [rowIndex, reading] of readings.entries()) {
		if (!reading.country) continue

		for (const [componentIndex, component] of reading.components.entries()) {
			if (component.kind === "closed") {
				probes.push({ rowIndex, componentIndex, position: "whole", country: reading.country, raw: component.value })
			} else if (component.kind === "open") {
				for (const word of component.words) {
					probes.push({ rowIndex, componentIndex, position: word.position, country: reading.country, raw: word.word })
				}
			}
		}
	}

	using db = await openDuckDB(limits)

	await db.run("CREATE TEMP TABLE shape_probes (row_index INTEGER, country VARCHAR, tag_set VARCHAR)")

	await db.run(
		"CREATE TEMP TABLE surface_probes (row_index INTEGER, component_index INTEGER, position VARCHAR, " +
			"country VARCHAR, raw VARCHAR)"
	)

	const shapeAppender = await db.createAppender("shape_probes")

	for (const [rowIndex, reading] of readings.entries()) {
		if (!reading.country) continue

		shapeAppender.appendInteger(rowIndex)
		shapeAppender.appendVarchar(reading.country)
		shapeAppender.appendVarchar(reading.tag_set)
		shapeAppender.endRow()
	}

	shapeAppender.closeSync()

	const surfaceAppender = await db.createAppender("surface_probes")

	for (const probe of probes) {
		surfaceAppender.appendInteger(probe.rowIndex)
		surfaceAppender.appendInteger(probe.componentIndex)
		surfaceAppender.appendVarchar(probe.position)
		surfaceAppender.appendVarchar(probe.country)
		surfaceAppender.appendVarchar(probe.raw)
		surfaceAppender.endRow()
	}

	surfaceAppender.closeSync()

	const shapeHits = (
		await db.runAndReadAll(
			`SELECT p.row_index, s.source, sum(s.rows)::BIGINT AS rows FROM shape_probes p ` +
				`JOIN read_parquet(${quoted(shapesPath)}) s ON s.country = p.country AND s.tag_set = p.tag_set ` +
				"GROUP BY ALL ORDER BY rows DESC"
		)
	).getRowObjectsJson() as Array<{ row_index: number; source: string; rows: string | number }>

	for (const hit of shapeHits) {
		const reading = readings[Number(hit.row_index)]!
		const count = Number(hit.rows)

		reading.shape_rows = (reading.shape_rows ?? 0) + count
		reading.shape_sources.push({ source: hit.source, rows: count })
	}

	const surfaceHits = (
		await db.runAndReadAll(
			`SELECT p.row_index, p.component_index, p.position AS probe_position, s.tag, s.position, ` +
				`sum(s.rows)::BIGINT AS rows FROM surface_probes p ` +
				`JOIN read_parquet(${quoted(surfacesPath)}) s ON s.country = p.country AND s.surface = ${foldSurfaceSQL("p.raw")} ` +
				"GROUP BY ALL"
		)
	).getRowObjectsJson() as Array<{
		row_index: number
		component_index: number
		probe_position: SurfacePosition
		tag: string
		position: SurfacePosition
		rows: string | number
	}>

	for (const hit of surfaceHits) {
		const component = readings[Number(hit.row_index)]!.components[Number(hit.component_index)]!
		const count = Number(hit.rows)

		if (hit.probe_position === "whole") {
			// A whole-surface probe reads whole-surface entries only.
			if (hit.position !== "whole") continue

			component.under_tags[hit.tag] = (component.under_tags[hit.tag] ?? 0) + count

			if (hit.tag === component.tag) {
				component.own_rows = (component.own_rows ?? 0) + count
			}
		} else {
			const word = component.words.find((entry) => entry.position === hit.probe_position)

			if (!word) continue

			const key = hit.position === "whole" ? hit.tag : `${hit.tag}/${hit.position}`

			word.under[key] = (word.under[key] ?? 0) + count
		}
	}

	return readings.map((reading) => ({ ...reading, rendered: renderSupportRow(reading) }))
}

// #endregion
