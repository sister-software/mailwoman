/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The `deletions[]` list of a corpus version manifest.
 *
 *   A stored parquet file is read-only, so a version drops rows by naming them rather than rewriting the file.
 *   Each deletion identifies a target, one stored file by its manifest path or every file of one source, and the
 *   `source_id` values it removes from that target, either inline or in a sidecar parquet with one `source_id`
 *   column. It also states why the rows leave and the issue that records the decision.
 *
 *   The trainer's loader (`corpus-python/.../data/loader/parquet.py`) applies the list as a set-membership test
 *   on each row's `source_id`, and the assembler counts the rows each deletion removes with the same test, so the
 *   manifest's split counts state what the loader reads.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { copyFileTo } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilder } from "path-ts"

import { readParquetRows } from "#parquet/readers"

/**
 * The file one deletion applies to: a stored file by the path the manifest lists,
 * or every file of one source.
 */
export type DeletionTarget = { path: string } | { source: string }

/**
 * A sidecar parquet holding the deleted `source_id` values in a `source_id` column.
 */
export interface DeletionIDsFile {
	/**
	 * The sidecar's path as the trainer reads it, under the version's Modal root.
	 */
	path: string
	sha256: string
	/**
	 * The number of distinct `source_id` values the sidecar holds.
	 */
	ids: number
}

/**
 * One entry of a version manifest's `deletions[]`.
 */
export interface CorpusDeletion {
	target: DeletionTarget
	/**
	 * The deleted ids, inline.
	 *
	 * A deletion holds this or {@linkcode source_ids_file}, never both.
	 */
	source_ids?: string[]
	source_ids_file?: DeletionIDsFile
	reason: string
	/**
	 * The issue that records the decision, as `#<number>`.
	 */
	issue: string
	/**
	 * The rows of the target files whose `source_id` the set holds, per split,
	 * counted when the version was assembled.
	 */
	rows_deleted: { train: number; val: number; test: number }
}

/**
 * What a caller asks to delete, before the assembler copies the sidecar and counts the rows.
 */
export interface DeletionRequest {
	target: DeletionTarget
	sourceIDs?: readonly string[]
	/**
	 * A local sidecar parquet with a `source_id` column.
	 */
	sourceIDsFile?: string
	reason: string
	issue: string
}

/**
 * The directory under a version's own directory that sidecar files are copied to.
 */
export const DELETIONS_DIRECTORY = "deletions"

const ISSUE_PATTERN = /^#[1-9]\d*$/u

/**
 * One deletion with its id set in memory and the manifest entry the assembler writes.
 */
export interface PreparedDeletion {
	deletion: Omit<CorpusDeletion, "rows_deleted">
	ids: ReadonlySet<string>
}

/**
 * Read the distinct `source_id` values of a deletion sidecar.
 *
 * @throws When the file is missing, lacks the column, or a row's `source_id` is not a non-empty string.
 */
export async function readDeletionIDs(path: string): Promise<Set<string>> {
	const rows = await readParquetRows<{ source_id: unknown }>(path, { columns: ["source_id"] })
	const ids = new Set<string>()

	for (const [index, row] of rows.entries()) {
		if (typeof row.source_id !== "string" || !row.source_id) {
			throw new Error(`${path} row ${index} holds no source_id, so the deletion it belongs to cannot be stated`)
		}

		ids.add(row.source_id)
	}

	return ids
}

/**
 * Validate one request, copy its sidecar into the version directory, and load its id set.
 *
 * @throws When the request names no reason, an issue not spelled `#<number>`, both
 * or neither of an inline list and a sidecar, or an empty set.
 */
export async function prepareDeletion(
	request: DeletionRequest,
	versionDir: PathBuilder,
	modalRoot: string
): Promise<PreparedDeletion> {
	const label = "path" in request.target ? `path ${request.target.path}` : `source ${request.target.source}`

	if (!request.reason.trim()) throw new Error(`the deletion of ${label} states no reason`)

	if (!ISSUE_PATTERN.test(request.issue)) {
		throw new Error(`the deletion of ${label} names issue ${stringifyJSON(request.issue)}; spell it #<number>`)
	}

	if (Boolean(request.sourceIDs) === Boolean(request.sourceIDsFile)) {
		throw new Error(`the deletion of ${label} must give either an inline source_id list or a sidecar parquet`)
	}

	const base = { target: request.target, reason: request.reason, issue: request.issue }

	if (request.sourceIDs) {
		const ids = new Set(request.sourceIDs)

		if (!ids.size) throw new Error(`the deletion of ${label} lists no source_id`)

		return { deletion: { ...base, source_ids: [...ids].toSorted() }, ids }
	}

	const local = request.sourceIDsFile!

	if (!(await pathExists(local))) throw new Error(`the deletion sidecar ${local} is absent`)

	const ids = await readDeletionIDs(local)

	if (!ids.size) throw new Error(`the deletion sidecar ${local} holds no source_id`)

	const sha256 = await sha256File(local)
	const name = `${sha256}.parquet`

	await copyFileTo(local, versionDir(DELETIONS_DIRECTORY, name))

	return {
		deletion: {
			...base,
			source_ids_file: { path: `${modalRoot}/${DELETIONS_DIRECTORY}/${name}`, sha256, ids: ids.size },
		},
		ids,
	}
}

/**
 * Whether a deletion's target matches a manifest file.
 */
export function deletionTargets(target: DeletionTarget, file: { path: string; source?: string }): boolean {
	return "path" in target ? target.path === file.path : target.source === file.source
}

/**
 * The `source_id` values of one parquet file that a set holds.
 */
export async function matchedSourceIDs(localPath: string, ids: ReadonlySet<string>): Promise<string[]> {
	const rows = await readParquetRows<{ source_id: string }>(localPath, { columns: ["source_id"] })

	return rows.map((row) => row.source_id).filter((id) => ids.has(id))
}

/**
 * Read a JSON file of deletion requests, as the `overlay-manifest` command takes them.
 *
 * @throws When the file does not hold an array.
 */
export async function readDeletionRequests(path: string): Promise<DeletionRequest[]> {
	const requests = await readLocalJSONFile<unknown>(path)

	if (!Array.isArray(requests)) throw new Error(`${path} holds no array of deletion requests`)

	return requests as DeletionRequest[]
}
