/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Locating the parquet files of a built corpus and opening DuckDB over them. Shared by the dev-tools that
 *   measure a training mixture.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { connectDuckDB, escapeSQLString } from "@mailwoman/corpus/parquet/duckdb"
import type { ParquetManifest } from "@mailwoman/corpus/parquet/writers"
import { join, type PathBuilderLike } from "path-ts"

/**
 * The manifest records the path the builder wrote under, which is the Modal volume mount
 * rather than this checkout's data root.
 *
 * Both spell the same tree below their first segment.
 */
const MANIFEST_ROOT = "/data/"

function localPath(manifestPath: string): PathBuilderLike {
	return manifestPath.startsWith(MANIFEST_ROOT) ? dataRootPath(manifestPath.slice(MANIFEST_ROOT.length)) : manifestPath
}

/**
 * A built corpus split, resolved to the files on this host.
 */
export interface MixtureFiles {
	manifest: ParquetManifest
	/**
	 * Absolute paths, in manifest order, of the files this run reads.
	 */
	files: PathBuilderLike[]
	/**
	 * Files the manifest holds for this split, which `files` may be a prefix of when the caller capped it.
	 */
	available: number
	/**
	 * Rows the manifest attributes to `files`.
	 */
	rows: number
}

/**
 * Resolve a corpus split's parquet files, raising when the manifest names a file this host does not hold.
 *
 * A missing file read as an empty result would report a composition for a corpus that is
 * only partly materialized, and nothing downstream can tell that from a real absence.
 */
export async function readMixtureFiles(corpusDirectory: string, split: string, limit?: number): Promise<MixtureFiles> {
	const manifest = await readLocalJSONFile<ParquetManifest>(join(corpusDirectory, "MANIFEST.json"))
	const entries = manifest.slices.filter((entry) => entry.split === split)

	if (!entries.length) {
		throw new Error(
			`${corpusDirectory}/MANIFEST.json records no ${split} split — it carries ` +
				`${[...new Set(manifest.slices.map((entry) => entry.split))].toSorted().join(", ")}.`
		)
	}

	const requested = limit ? entries.slice(0, limit) : entries
	const files: PathBuilderLike[] = []

	for (const entry of requested) {
		const path = localPath(entry.path)

		if (!(await pathExists(path))) {
			throw new Error(`${entry.path} resolves to ${path}, which is not on this host. The corpus is not materialized.`)
		}

		files.push(path)
	}

	return {
		manifest,
		files,
		available: entries.length,
		rows: requested.reduce((sum, entry) => sum + entry.rows, 0),
	}
}

/**
 * A DuckDB connection bounded to the memory and threads a caller is willing to spend,
 * plus the file list spelled for `read_parquet`.
 */
export async function openMixture(
	files: readonly PathBuilderLike[],
	options: { memoryLimit: string; threads: number }
): Promise<{ db: Awaited<ReturnType<typeof connectDuckDB>>; fileList: string }> {
	const db = await connectDuckDB()

	await db.run(`SET memory_limit='${escapeSQLString(options.memoryLimit)}'`)
	await db.run(`SET threads=${options.threads}`)

	return { db, fileList: files.map((path) => `'${escapeSQLString(path.toString())}'`).join(", ") }
}
