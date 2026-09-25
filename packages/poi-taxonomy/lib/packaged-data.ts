/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the package's shipped `data/` tables. This module runs only in Node. The browser-safe
 *   `./table` entry takes its table from the caller instead.
 */

import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"

const moduleDir = import.meta.dirname

/**
 * Returns the absolute path to `data/<filename>`.
 *
 * The `data/` directory sits at the package root.
 * The function looks for it inside this module's directory and in the parent directory.
 *
 * The function checks that the file exists instead of trying to parse it.
 * A parse attempt would report a corrupt table as a missing one.
 */
async function resolvePackagedDataPath(filename: string): Promise<string> {
	const candidates = [resolvePath(moduleDir, "data", filename), resolvePath(moduleDir, "..", "data", filename)]
	const probes: Array<[string, boolean]> = []

	for (const candidate of candidates) {
		probes.push([candidate, await pathExists(candidate)])
	}

	const found = probes.find(([, exists]) => exists)?.[0]

	if (!found) {
		throw new Error(`poi-taxonomy: could not find data/${filename} — looked in ${candidates.join(", ")}`)
	}

	return found
}

/**
 * Reads and parses one of the package's shipped `data/` tables.
 */
export async function readPackagedTable<T>(filename: string): Promise<T> {
	const path = await resolvePackagedDataPath(filename)

	// A corrupt shipped table means a broken build, so the parse error propagates with its offset.
	// oxlint-disable-next-line no-restricted-properties -- zero-dependency leaf. corrupt shipped data must throw with its offset
	return (await readLocalJSONFile(path)) as T
}
