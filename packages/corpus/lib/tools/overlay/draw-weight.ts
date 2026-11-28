// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Rewrites one source's stored parquet files with a `draw_weight` column,
 *   for a corpus overlay that replaces the source's base files.
 *
 *   A row's raw weight is the score of the record its `source_id` names,
 *   raised to `floor`, and a record without a score takes `floor`.
 *   The raw weights are divided by their mean over the source's train rows,
 *   so the mean draw weight of the rows a train mixture reads is 1.
 *
 *   The sampler multiplies a row's draw weight into its acceptance draw after the
 *   mixture has picked the source, so the weights move draws between the source's rows
 *   and the source's share of the run stays where the training config puts it.
 *
 *   Each rewritten file keeps its rows, their order and every stored column, and appends the weight.
 *   Its split attribute is the base attribute with the new file's name, sha256 and row count,
 *   so the held-out ids and the policy hash are the ones the holdout policy wrote for the base file.
 *
 *   The rewrite refuses a file whose rows it cannot match one to one by `source_id` and `raw`.
 */

import { sha256File } from "@mailwoman/core/crypto/hash"
import { makeDirectories, movePath, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { basename, PathBuilder, type PathBuilderLike } from "path-ts"

import { type DuckDBLimits, escapeSQLString, openDuckDB } from "#parquet/duckdb"
import { DRAW_WEIGHT_COLUMN, PARQUET_COMPRESSION, ROW_GROUP_SIZE } from "#parquet/schema"
import { readSplitAttribute, splitAttributeFilename } from "#tools/overlay/split/attribute"

/**
 * One stored file of the source and its split attribute, by local path.
 */
export interface DrawWeightInputFile {
	parquet: string
	splitAttribute: string
}

export interface DrawWeightOverlayOptions {
	/**
	 * The `source` value every row of the files holds.
	 */
	source: string
	files: readonly DrawWeightInputFile[]
	/**
	 * A regular expression whose first group captures the integer record id inside a row's `source_id`.
	 */
	keyPattern: string
	/**
	 * Each scored record's score, by id.
	 * A record absent from the table has no score.
	 */
	scores: ReadonlyMap<number, number>
	/**
	 * The raw weight of a row whose record has no score, and the least raw weight of any row.
	 */
	floor: number
	/**
	 * The overlay directory.
	 *
	 * Each rewritten file and its attribute are written at its top level.
	 */
	outDir: PathBuilderLike
	limits?: DuckDBLimits
}

/**
 * One rewritten file, by its name under the overlay directory.
 */
export interface DrawWeightedFile {
	parquet: string
	splitAttribute: string
	rows: number
}

/**
 * The weights the rewrite wrote, measured over the source's train rows.
 */
export interface DrawWeightSummary {
	files: DrawWeightedFile[]
	floor: number
	trainRows: number
	/**
	 * Train rows whose record has a score.
	 */
	scoredTrainRows: number
	/**
	 * Train rows whose raw weight is the floor: every unscored row, and each scored row below it.
	 */
	floorTrainRows: number
	/**
	 * The mean raw weight over the train rows.
	 * Every raw weight is divided by this mean.
	 */
	rawTrainMean: number
	/**
	 * The draw weight of a floor row.
	 */
	floorWeight: number
	/**
	 * The largest draw weight in the files, the bound the sampler divides by.
	 */
	maxWeight: number
	/**
	 * Draw-weight quantiles over the train rows, keyed by quantile.
	 */
	quantiles: Record<string, number>
}

const QUANTILES = [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999] as const

/**
 * Writes each of `files` again with a `draw_weight` column and the split
 * attribute that describes the new file.
 *
 * @throws When a row's `source_id` yields no record id, a row holds another source,
 * a file already stores the column, or a rewritten file's rows differ from the input's.
 */
export async function writeDrawWeightedFiles(options: DrawWeightOverlayOptions): Promise<DrawWeightSummary> {
	const { source, files, keyPattern, scores, floor } = options

	if (!(Number.isFinite(floor) && floor > 0)) throw new Error(`the floor must be a positive number, got ${floor}`)

	const outDir = PathBuilder.from(options.outDir)

	await makeDirectories(outDir)

	using db = await openDuckDB(options.limits)

	await db.run("CREATE TEMP TABLE scores (id BIGINT, score DOUBLE)")
	await db.run("CREATE TEMP TABLE held_out (file INTEGER, id VARCHAR)")

	const scoreAppender = await db.createAppender("scores")

	for (const [id, score] of scores) {
		scoreAppender.appendBigInt(BigInt(id))
		scoreAppender.appendDouble(score)
		scoreAppender.endRow()
	}

	scoreAppender.closeSync()

	const attributes = await Promise.all(files.map((file) => readSplitAttribute(file.splitAttribute)))
	const heldAppender = await db.createAppender("held_out")

	for (const [index, attribute] of attributes.entries()) {
		for (const id of [...attribute.val, ...attribute.test]) {
			heldAppender.appendInteger(index)
			heldAppender.appendVarchar(id)
			heldAppender.endRow()
		}
	}

	heldAppender.closeSync()

	const scan = (path: string) => `read_parquet('${escapeSQLString(path)}', file_row_number = true)`

	await db.run(
		"CREATE TEMP TABLE weights (file INTEGER, file_row_number BIGINT, source VARCHAR, record BIGINT, " +
			"scored BOOLEAN, raw DOUBLE, train BOOLEAN)"
	)

	for (const [index, file] of files.entries()) {
		const columns = (await db.runAndReadAll(`SELECT name FROM parquet_schema('${escapeSQLString(file.parquet)}')`))
			.getRowObjectsJson()
			.map((row) => String(row["name"]))

		if (columns.includes(DRAW_WEIGHT_COLUMN)) {
			throw new Error(`${file.parquet} already stores ${DRAW_WEIGHT_COLUMN}, so a rewrite would hold it twice`)
		}

		await db.run(
			`INSERT INTO weights SELECT ${index}, p.file_row_number, p.source, p.record, s.score IS NOT NULL, ` +
				`greatest(coalesce(s.score, ${floor}), ${floor}), ` +
				`p.source_id NOT IN (SELECT id FROM held_out WHERE file = ${index}) ` +
				`FROM (SELECT file_row_number, source, source_id, ` +
				`TRY_CAST(regexp_extract(source_id, '${escapeSQLString(keyPattern)}', 1) AS BIGINT) AS record ` +
				`FROM ${scan(file.parquet)}) p LEFT JOIN scores s ON s.id = p.record`
		)
	}

	const refused = (
		await db.runAndReadAll(
			`SELECT count(*) FILTER (WHERE record IS NULL) AS keyless, ` +
				`count(*) FILTER (WHERE source IS DISTINCT FROM '${escapeSQLString(source)}') AS foreign FROM weights`
		)
	).getRowObjectsJson()[0]!

	if (Number(refused["keyless"]) || Number(refused["foreign"])) {
		throw new Error(
			`${refused["keyless"]} row(s) carry a source_id without a record id under ${keyPattern}, and ` +
				`${refused["foreign"]} row(s) hold a source other than ${source}; each row needs one record's weight`
		)
	}

	const stats = (
		await db.runAndReadAll(
			`SELECT count(*) AS train, count(*) FILTER (WHERE scored) AS scored, ` +
				`count(*) FILTER (WHERE raw = ${floor}) AS at_floor, avg(raw) AS mean FROM weights WHERE train`
		)
	).getRowObjectsJson()[0]!

	const rawTrainMean = Number(stats["mean"])

	if (!(rawTrainMean > 0)) throw new Error(`the ${source} files hold no train row to normalize over`)

	const quantileRow = (
		await db.runAndReadAll(
			`SELECT quantile_cont(raw / ${rawTrainMean}, [${QUANTILES.join(", ")}]) AS q, ` +
				`(SELECT max(raw) FROM weights) / ${rawTrainMean} AS max_weight FROM weights WHERE train`
		)
	).getRowObjectsJson()[0]!

	const quantileValues = quantileRow["q"] as number[]
	const written: DrawWeightedFile[] = []

	for (const [index, file] of files.entries()) {
		const staging = outDir(`${source}.draw-weight.${index}.parquet.partial`).toString()

		await db.run(
			`COPY (SELECT p.* EXCLUDE (file_row_number), w.raw / ${rawTrainMean} AS ${DRAW_WEIGHT_COLUMN} ` +
				`FROM ${scan(file.parquet)} p JOIN weights w ON w.file = ${index} AND w.file_row_number = p.file_row_number ` +
				`ORDER BY p.file_row_number) TO '${escapeSQLString(staging)}' ` +
				`(FORMAT parquet, COMPRESSION ${PARQUET_COMPRESSION}, ROW_GROUP_SIZE ${ROW_GROUP_SIZE})`
		)

		const matched = (
			await db.runAndReadAll(
				`SELECT (SELECT count(*) FROM ${scan(file.parquet)}) AS input, ` +
					`(SELECT count(*) FROM ${scan(staging)}) AS output, count(*) AS same FROM ${scan(file.parquet)} a ` +
					`JOIN ${scan(staging)} b USING (file_row_number) WHERE a.source_id = b.source_id AND a.raw = b.raw`
			)
		).getRowObjectsJson()[0]!

		const rows = Number(matched["input"])

		if (Number(matched["output"]) !== rows || Number(matched["same"]) !== rows) {
			throw new Error(
				`${staging} holds ${matched["output"]} rows, ${matched["same"]} of them matching ${file.parquet}'s ${rows} ` +
					`by position, source_id and raw, so it is not the same rows with a weight added`
			)
		}

		const sha256 = await sha256File(staging)
		const name = `${source}-${sha256}.parquet`

		await movePath(staging, outDir(name))

		const attribute = attributes[index]!
		const attributeName = splitAttributeFilename(name, attribute.policyHash)

		if (attribute.file.rows !== rows) {
			throw new Error(
				`${file.splitAttribute} describes ${attribute.file.rows} rows and ${basename(file.parquet)} holds ${rows}`
			)
		}

		await writeLocalJSONFile({ ...attribute, file: { name, sha256, rows } }, outDir(attributeName))

		written.push({ parquet: name, splitAttribute: attributeName, rows })
	}

	return {
		files: written,
		floor,
		trainRows: Number(stats["train"]),
		scoredTrainRows: Number(stats["scored"]),
		floorTrainRows: Number(stats["at_floor"]),
		rawTrainMean,
		floorWeight: floor / rawTrainMean,
		maxWeight: Number(quantileRow["max_weight"]),
		quantiles: Object.fromEntries(QUANTILES.map((q, i) => [String(q), quantileValues[i]!])),
	}
}
