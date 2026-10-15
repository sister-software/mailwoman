/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The file names of PFX1 postcode-prefix indexes. The data root holds one dated file per build
 *   under `postcode-prefix/`, and a weights package ships the newest of each scope under the
 *   scope's own name. The loaders, the dev overlay linker and the release copy read the same
 *   listing here so they agree on which file a scope resolves to.
 */

import { PathBuilder, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { dataRootPath } from "#data-root"
import { tryStat } from "#fs/readers/stat"

/**
 * The data-root directory that holds the dated PFX1 postcode-prefix indexes.
 */
export const POSTCODE_PREFIX_DIRECTORY = dataRootPath("postcode-prefix")

/**
 * The glob that matches a postcode-prefix index file, dated or shipped.
 */
export const POSTCODE_PREFIX_FILE_GLOB = "postcode-prefix-*.bin"

const DATED_FILE = /^postcode-prefix-(?<scope>.+)-(?<date>\d{4}-\d{2}-\d{2})\.bin$/
const SHIPPED_FILE = /^postcode-prefix-(?<scope>.+)\.bin$/

/**
 * Returns the file name a weights package ships a scope's index under, such as `postcode-prefix-us.bin`.
 */
export function shippedPostcodePrefixName(scope: string): string {
	return `postcode-prefix-${scope}.bin`
}

/**
 * Returns the scope a postcode-prefix file name belongs to, such as `gb-esw`
 * for `postcode-prefix-gb-esw-2026-08-05.bin` or `postcode-prefix-gb-esw.bin`,
 * or `null` for a name of another shape.
 */
export function postcodePrefixScopeOf(fileName: string): string | null {
	return DATED_FILE.exec(fileName)?.groups?.scope ?? SHIPPED_FILE.exec(fileName)?.groups?.scope ?? null
}

/**
 * One postcode-prefix index file chosen for its scope.
 */
export interface PostcodePrefixFile {
	scope: string
	path: PathBuilder
	mtimeMs: number
}

/**
 * Lists the newest postcode-prefix index of each scope under `directory`, by modification time.
 *
 * An absent directory lists no file.
 * A file whose name has no scope is skipped.
 */
export async function newestPostcodePrefixFiles(
	directory: PathBuilderLike = POSTCODE_PREFIX_DIRECTORY
): Promise<Map<string, PostcodePrefixFile>> {
	const newest = new Map<string, PostcodePrefixFile>()

	if (!(await tryStat(directory))) return newest

	for await (const entry of Globerator.from(POSTCODE_PREFIX_FILE_GLOB, { cwd: directory.toString() })) {
		const scope = postcodePrefixScopeOf(entry)

		if (!scope) continue

		const path = PathBuilder.from(directory, entry)
		const stat = await tryStat(path)

		if (!stat) continue

		const current = newest.get(scope)

		if (!current || stat.mtimeMs > current.mtimeMs) {
			newest.set(scope, { scope, path, mtimeMs: stat.mtimeMs })
		}
	}

	return newest
}
