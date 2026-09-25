/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIClient, pluckResponseData } from "@mailwoman/core/api"
import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { sentenceCaseSnake } from "@mailwoman/core/strings/case"
import { compareByCodePoint } from "@mailwoman/core/strings/compare"
import { resolvePath } from "path-ts"
import { CSVSpliterator } from "spliterator"

import type { CategoryRecord, POICategoryID, POITaxonomyTable, SynonymEntry } from "#types"

/**
 * The Overture schema release the committed `overture-categories.csv` snapshot was taken from.
 */
export const OVERTURE_RELEASE = "v1.17.0"

/**
 * This taxonomy table's own data version — bump when the snapshot vintage or merge semantics change.
 */
export const TAXONOMY_VERSION = "0.4.0"

/**
 * Source URL for `--fetch` and provenance.
 */
export const OVERTURE_CATEGORIES_URL =
	"https://raw.githubusercontent.com/OvertureMaps/schema/main/docs/schema/concepts/by-theme/places/overture_categories.csv"

/**
 * One parsed Overture snapshot row: a category code plus its top-down hierarchy path (ending with the code).
 */
export interface OvertureSnapshotRow {
	code: string
	path: string[]
}

/**
 * The hand-maintained curated overlay — the shape of `data/curated-overlay.json`.
 */
export interface CuratedOverlay {
	categories: CategoryRecord[]
	synonyms: SynonymEntry[]
}

/**
 * Parses the semicolon-delimited Overture categories CSV into rows of category code
 * and top-down hierarchy path.
 *
 * When a row's display path ends in a label other than its code, the code is appended
 * as the leaf, because consumers rely on `hierarchy.at(-1) === id`.
 *
 * @throws On a malformed row or a repeated code.
 */
export function parseOvertureCSV(csvText: string): OvertureSnapshotRow[] {
	const rows: OvertureSnapshotRow[] = []
	const seen = new Set<string>()

	let rowNumber = 1

	for (const fields of CSVSpliterator.from<string[]>(csvText, {
		mode: "array",
		columnDelimiter: ";",
	})) {
		rowNumber++

		const [rawCode, rawPath, ...rest] = fields

		if (rawCode === undefined || rawPath === undefined || rest.length) {
			throw new Error(`generate-taxonomy: malformed CSV row ${rowNumber}: ${stringifyJSON(fields.join(";"))}`)
		}

		const code = rawCode.trim()
		const pathText = rawPath.trim().replaceAll(/^\[|\]$/g, "")
		const path = pathText.split(",").map((p) => p.trim())

		if (!code || !path.length || path.some((p) => !p)) {
			throw new Error(
				`generate-taxonomy: malformed CSV row ${rowNumber}: code ${stringifyJSON(code)} path ${stringifyJSON(pathText)}`
			)
		}

		if (seen.has(code)) throw new Error(`generate-taxonomy: duplicate Overture code ${stringifyJSON(code)}`)

		if (path.at(-1) !== code) {
			path.push(code)
		}

		seen.add(code)
		rows.push({ code, path })
	}

	return rows
}

/**
 * Merges the Overture snapshot with the curated overlay into a deterministically
 * sorted {@link POITaxonomyTable} without I/O.
 *
 * Curated categories replace Overture rows with the same code, and they absorb the
 * Overture leaves they list unless `retainOvertureLeaves` is set.
 */
export function buildTaxonomyTable(snapshot: OvertureSnapshotRow[], overlay: CuratedOverlay): POITaxonomyTable {
	const curatedIDs = new Set<string>(overlay.categories.map((c) => c.id))

	const absorbedLeaves = new Set<string>(
		overlay.categories.flatMap((c) => (c.retainOvertureLeaves ? [] : (c.overtureCategories ?? [])))
	)

	const snapshotRecords: CategoryRecord[] = snapshot
		.filter((row) => !curatedIDs.has(row.code) && !absorbedLeaves.has(row.code))
		.map((row) => ({
			id: row.code as POICategoryID,
			label: sentenceCaseSnake(row.code),
			hierarchy: row.path as POICategoryID[],
			basicLabel: null,
			source: "overture",
		}))

	const categories = [...overlay.categories, ...snapshotRecords].toSorted((a, b) => compareByCodePoint(a.id, b.id))

	const synonyms = [...overlay.synonyms].toSorted(
		(a, b) => compareByCodePoint(a.phrase, b.phrase) || compareByCodePoint(a.categoryID, b.categoryID)
	)

	return { version: TAXONOMY_VERSION, overtureRelease: OVERTURE_RELEASE, categories, synonyms }
}

/**
 * Resolves the committed snapshot CSV, curated overlay and generated `taxonomy.json`
 * paths in the package's `data` directory.
 */
export function taxonomyPaths() {
	const dataDir = resolvePackagePath("@mailwoman/poi-taxonomy", "data")

	return {
		csv: resolvePath(dataDir, "overture-categories.csv"),
		overlay: resolvePath(dataDir, "curated-overlay.json"),
		out: resolvePath(dataDir, "taxonomy.json"),
	}
}

/**
 * Read the committed CSV + overlay, merge, and return the table (no write).
 */
export async function generateTaxonomyTable(): Promise<POITaxonomyTable> {
	const paths = taxonomyPaths()
	const snapshot = parseOvertureCSV(await readLocalTextFile(paths.csv))
	const overlay = await readLocalJSONFile<CuratedOverlay>(paths.overlay)

	return buildTaxonomyTable(snapshot, overlay)
}

async function main(): Promise<void> {
	const { values } = parseArguments({ options: { fetch: { type: "boolean", default: false } } })
	const paths = taxonomyPaths()

	if (values.fetch) {
		const csv = await new APIClient({ displayName: "overture-categories", retry: true })
			.fetch<string>({ url: OVERTURE_CATEGORIES_URL, responseType: "text" })
			.then(pluckResponseData)

		await writeLocalFile(csv, paths.csv)

		console.log(`fetched snapshot → ${paths.csv}`)
	}

	const table = await generateTaxonomyTable()

	await writeLocalJSONFile(table, paths.out)

	console.log(
		`wrote ${paths.out}: ${table.categories.length} categories (${table.synonyms.length} synonyms), Overture ${table.overtureRelease}`
	)
}

runIfScript(import.meta, main)
