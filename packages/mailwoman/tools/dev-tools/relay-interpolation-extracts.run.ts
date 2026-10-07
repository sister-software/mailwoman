/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Rewrite built interpolation extracts in the row order and index shape the current builder produces.
 *
 *   An extract built before `clusterStreetSegments` stores its `street_segment` rows in source order.
 *   A browser lookup over HTTP range requests then fetches each candidate row from a different part of the file.
 *   This tool copies every row of such an extract through the builder's own staging, ordering and index
 *   functions, so the output has the same layout as a fresh build without a TIGER download.
 *
 *   The source files are read-only. Each output is written to `<out>/<slug>/interp.db`, which is the
 *   layout the public bucket serves under `street/us/<slug>/<version>/`. A source table other than
 *   `street_segment` is copied as it is.
 *
 *   Usage: node packages/mailwoman/tools/dev-tools/relay-interpolation-extracts.run.ts --out <dir>
 *   [--source <dir>] [--state <slug>]
 */

import { statPath } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { interpolationDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import {
	clusterStreetSegments,
	createStreetSegmentIndexes,
	createStreetSegmentTable,
	STREET_SEGMENT_COLUMNS,
	STREET_SEGMENT_STAGE_TABLE,
	type StreetSegmentDatabase,
} from "@mailwoman/resolver-wof-sqlite/street/segment-schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { type PathBuilderLike, resolvePathBuilder } from "path-ts"
import { Globerator } from "spliterator/node/fs"

const EXTRACT_NAME = /^interpolation-us-([a-z]+(?:-[a-z]+)*)\.db$/u

const SQLITE_SIDECAR_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const

/**
 * What one rewritten extract measured.
 */
export interface RelaidExtract {
	slug: string
	rows: number
	sourceBytes: number
	outputBytes: number
}

const sqlText = (value: string): string => `'${value.replaceAll("'", "''")}'`

/**
 * Rewrite one extract into `outputPath` and verify it.
 *
 * @throws When the output's row count differs from the source's, or SQLite's `quick_check` reports damage.
 */
export async function relayInterpolationExtract(
	sourcePath: PathBuilderLike,
	outputPath: PathBuilderLike
): Promise<{ rows: number }> {
	for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
		await removePathIfPresent(`${outputPath}${suffix}`)
	}

	{
		using db = new DatabaseClient<StreetSegmentDatabase>(outputPath)
		const columns = STREET_SEGMENT_COLUMNS.join(", ")

		// A journal restores an existing database after a failed write.
		// This file is new, and a failed run deletes and rewrites it.
		db.exec("PRAGMA page_size=4096; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;")
		await createStreetSegmentTable(db)
		await createStreetSegmentTable(db, STREET_SEGMENT_STAGE_TABLE)
		db.exec(`ATTACH ${sqlText(String(sourcePath))} AS source`)

		// Source rowid order preserves the order the readers break span ties by.
		db.exec(
			`INSERT INTO ${STREET_SEGMENT_STAGE_TABLE} (${columns}) SELECT ${columns} FROM source.street_segment ORDER BY rowid`
		)

		const otherTables = db
			.prepare(
				"SELECT name, sql FROM source.sqlite_master WHERE type = 'table' AND name != 'street_segment' AND name NOT LIKE 'sqlite_%'"
			)
			.all() as Array<{ name: string; sql: string }>

		for (const table of otherTables) {
			db.exec(table.sql)
			db.exec(`INSERT INTO "${table.name}" SELECT * FROM source."${table.name}"`)
		}

		db.exec("DETACH source")
		await clusterStreetSegments(db)
		await createStreetSegmentIndexes(db)
		db.exec("VACUUM")
	}

	using output = new DatabaseClient<StreetSegmentDatabase>(outputPath, { readOnly: true })
	using source = new DatabaseClient<StreetSegmentDatabase>(sourcePath, { readOnly: true })

	const countRows = (db: DatabaseClient<StreetSegmentDatabase>): number =>
		(db.prepare("SELECT count(*) AS n FROM street_segment").get() as { n: number }).n

	const rows = countRows(output)
	const expected = countRows(source)
	const integrity = (output.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check

	if (rows !== expected) {
		throw new Error(`${outputPath} holds ${rows} rows and ${sourcePath} holds ${expected}`)
	}

	if (integrity !== "ok") {
		throw new Error(`${outputPath} failed quick_check: ${integrity}`)
	}

	return { rows }
}

/**
 * Rewrite every `interpolation-us-<slug>.db` under `sourceDirectory`, or the one `onlySlug` selects.
 */
export async function relayInterpolationExtracts(
	sourceDirectory: PathBuilderLike,
	outputDirectory: PathBuilderLike,
	onlySlug?: string
): Promise<RelaidExtract[]> {
	const files = (
		await Globerator.files("db", { cwd: sourceDirectory, absolute: false, recursive: false }).toSorted()
	).filter((file) => EXTRACT_NAME.test(file))

	const report: RelaidExtract[] = []

	for (const file of files) {
		const slug = EXTRACT_NAME.exec(file)![1]!

		if (onlySlug && slug !== onlySlug) continue

		const sourcePath = resolvePathBuilder(sourceDirectory, file)
		const slugDirectory = resolvePathBuilder(outputDirectory, slug)
		const outputPath = resolvePathBuilder(slugDirectory, "interp.db")

		await makeDirectories(slugDirectory)

		const { rows } = await relayInterpolationExtract(sourcePath, outputPath)

		report.push({
			slug,
			rows,
			sourceBytes: (await statPath(sourcePath)).size,
			outputBytes: (await statPath(outputPath)).size,
		})
	}

	if (onlySlug && !report.length) {
		throw new Error(`No interpolation-us-${onlySlug}.db under ${sourceDirectory}`)
	}

	return report
}

async function main(): Promise<void> {
	const { values } = parseArguments({
		options: {
			source: { type: "string" },
			out: { type: "string" },
			state: { type: "string" },
		},
	})

	if (!values.out) {
		throw new Error("--out <dir> is required; the tool never writes into the source directory")
	}

	const report = await relayInterpolationExtracts(
		values.source ?? interpolationDatabasePath,
		values.out,
		values.state?.toLowerCase()
	)

	for (const row of report) {
		console.log(`${row.slug}\trows ${row.rows}\t${row.sourceBytes} -> ${row.outputBytes} bytes`)
	}

	console.log(`extracts rewritten: ${report.length}; rows: ${report.reduce((sum, row) => sum + row.rows, 0)}`)
}

runIfScript(import.meta, main)
