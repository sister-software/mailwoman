/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Locates a built corpus's parquet files and opens DuckDB over them for mixture measurements.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { type DuckDBConnection, escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import type { ParquetManifest } from "@mailwoman/corpus/parquet/writers"
import { PathBuilder, type PathBuilderLike } from "path-ts"

/**
 * Sets the Modal volume mount that manifest paths start with.
 *
 * The tree below it matches the tree below this checkout's data root.
 */
const MANIFEST_ROOT = "/data/"

/**
 * Maps a manifest path under the Modal mount to the same file under the local data root.
 */
function localPath(manifestPath: string): PathBuilderLike {
	return manifestPath.startsWith(MANIFEST_ROOT) ? dataRootPath(manifestPath.slice(MANIFEST_ROOT.length)) : manifestPath
}

/**
 * Holds one corpus split resolved to files on this host.
 */
export interface MixtureFiles {
	manifest: ParquetManifest
	/**
	 * Lists the paths this run reads, in manifest order.
	 */
	files: PathBuilderLike[]
	/**
	 * Counts the split's files in the manifest.
	 * `files` is a prefix of them when the caller set a limit.
	 */
	available: number
	/**
	 * Counts the rows the manifest attributes to `files`.
	 */
	rows: number
}

/**
 * Resolves a corpus split's parquet files.
 *
 * @throws If the split is absent or a listed file is missing on this host,
 * so a partly materialized corpus never reports a composition.
 */
export async function readMixtureFiles(
	corpusDirectory: PathBuilderLike,
	split: string,
	limit?: number
): Promise<MixtureFiles> {
	const manifestPath = PathBuilder.from(corpusDirectory)("MANIFEST.json")
	const manifest = await readLocalJSONFile<ParquetManifest>(manifestPath)
	const entries = manifest.slices.filter((entry) => entry.split === split)

	if (!entries.length) {
		throw new Error(
			`${manifestPath} records no ${split} split — it carries ` +
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
 * Opens a DuckDB connection with the given memory and thread limits.
 *
 * It also returns the files as a quoted list for `read_parquet`.
 */
export async function openMixture(
	files: readonly PathBuilderLike[],
	options: { memoryLimit: string; threads: number }
): Promise<{ db: DuckDBConnection; fileList: string } & AsyncDisposable> {
	const handle = await openDuckDB()
	const db = handle.connection

	await db.run(`SET memory_limit='${escapeSQLString(options.memoryLimit)}'`)
	await db.run(`SET threads=${options.threads}`)

	return {
		db,
		fileList: files.map((path) => `'${escapeSQLString(path.toString())}'`).join(", "),
		[Symbol.asyncDispose]: () => handle[Symbol.asyncDispose](),
	}
}
