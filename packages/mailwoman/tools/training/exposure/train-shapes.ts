// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Counts a built corpus's train rows per source, country and ordered span tags, in one DuckDB query.
 *
 *   The rows are the ones the sampler's train split admits (`mtf-sampler` `corpus_split_files`): every row of a file
 *   the manifest lists as `train`, and every row of a file with a split attribute whose `source_id` the attribute holds
 *   in neither `val` nor `test`. A filtered file never admits a row with no `source_id`. A held-out id applies to its
 *   own file only, since one id can sit in two files.
 *
 *   The addon's `SplitColumns` reads the same rows and converts every row's span tags to JavaScript. Over the whole
 *   corpus that conversion costs hours, and this query groups the rows inside DuckDB instead.
 *   The count applies neither the coarse filter nor the astral skip. Both drop a few rows at draw time.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { openWriteStream } from "@mailwoman/core/fs/streams"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { localManifestFilePath } from "@mailwoman/corpus/tools/overlay/manifest"

/**
 * A count of train rows sharing one source, country and span-tag sequence.
 */
export interface TrainShapeCount {
	source: string | null
	country: string | null
	spanTags: string[] | null
	rows: number
}

interface ManifestFile {
	path: string
	split?: string
	split_attribute?: { path: string }
}

/**
 * Options for {@linkcode countTrainShapes}.
 */
export interface TrainShapeOptions {
	memoryLimitBytes?: number
	threads?: number
}

/**
 * Counts the train rows of the corpus whose `MANIFEST.json` is at `manifestPath`.
 *
 * @throws When the manifest records deletions (this count applies none), or lists no train file.
 */
export async function countTrainShapes(
	manifestPath: string,
	options: TrainShapeOptions = {}
): Promise<TrainShapeCount[]> {
	const manifest = await readLocalJSONFile<{ files: ManifestFile[]; deletions?: unknown[] }>(manifestPath)

	if (manifest.deletions?.length) {
		throw new Error(
			`${manifestPath} records ${manifest.deletions.length} deletions; the train-shape count applies none`
		)
	}

	const files = manifest.files.filter((file) => file.split === "train" || file.split_attribute)

	if (!files.length) throw new Error(`${manifestPath} lists no train file`)

	await using scratch = await temporaryDirectory("train-shapes-")
	const heldJSONL = scratch.path("held.jsonl").toString()
	const attributed: string[] = []

	{
		const out = openWriteStream(heldJSONL, { encoding: "utf8" })

		// One row keeps the table's columns typed when no file holds out an id.
		out.write(stringifyJSON({ file: "", source_id: "" }) + "\n")

		for (const file of files) {
			if (!file.split_attribute) continue

			const local = localManifestFilePath(file.path)

			const attribute = await readLocalJSONFile<{ val: string[]; test: string[] }>(
				localManifestFilePath(file.split_attribute.path)
			)

			attributed.push(local)

			for (const id of [...attribute.val, ...attribute.test]) {
				out.write(stringifyJSON({ file: local, source_id: id }) + "\n")
			}
		}

		await new Promise<void>((resolve, reject) => {
			out.end((error: Error | null) => (error ? reject(error) : resolve()))
		})
	}

	using db = await openDuckDB(options)

	const quoted = (paths: readonly string[]) => paths.map((path) => `'${escapeSQLString(path)}'`).join(", ")

	await db.run(
		`CREATE TEMP TABLE held AS SELECT DISTINCT file, source_id FROM read_json('${escapeSQLString(heldJSONL)}', format='newline_delimited')`
	)

	await db.run(
		`CREATE TEMP TABLE attributed AS SELECT unnest([${quoted(attributed.length ? attributed : [""])}]) AS file`
	)

	const paths = quoted(files.map((file) => localManifestFilePath(file.path)))

	const reader = await db.runAndReadAll(`
		SELECT p.source AS source, p.country AS country, p.span_tags AS span_tags, count(*)::BIGINT AS rows
		FROM read_parquet([${paths}], union_by_name = true, filename = true) p
		LEFT JOIN held h ON h.file = p.filename AND h.source_id = p.source_id
		WHERE h.source_id IS NULL
			AND (p.source_id IS NOT NULL OR p.filename NOT IN (SELECT file FROM attributed))
		GROUP BY ALL`)

	return (reader.getRowObjectsJson() as Array<Record<string, unknown>>).map((row) => ({
		source: (row.source as string | null) ?? null,
		country: (row.country as string | null) ?? null,
		spanTags: (row.span_tags as string[] | null) ?? null,
		rows: Number(row.rows),
	}))
}
