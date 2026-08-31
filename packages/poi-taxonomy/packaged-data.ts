/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Locating the package's own shipped `data/` tables. Node-only — the browser-safe `./table` entry
 *   takes its table from the caller and never reaches the filesystem.
 */

import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"

const moduleDir = import.meta.dirname

/**
 * Absolute path to `data/<filename>`.
 *
 * `data/` sits at the package root (it is a `files` entry), and this module sits either at that root — running from
 * source — or under `out/` when compiled. So there are exactly two places to look, not three.
 *
 * The probe tests for the FILE. Probing by attempting a parse, as the per-table loaders used to, folds two different
 * failures into one: a corrupt `taxonomy.json` throws, gets swallowed as "not this candidate", and the package reports
 * a missing table it is in fact looking straight at.
 *
 * A local copy of `@mailwoman/core/module/packaged-data`'s `resolvePackagedDataPath`, kept here to preserve this
 * package's zero-dependency contract.
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
 * Read and parse one of the package's shipped `data/` tables.
 */
export async function readPackagedTable<T>(filename: string): Promise<T> {
	const path = await resolvePackagedDataPath(filename)

	// A corrupt shipped table is a broken build, and the SyntaxError names the offset. `poi-taxonomy` declares zero
	// dependencies, so `@mailwoman/core`'s parse wrappers are deliberately out of reach.
	// oxlint-disable-next-line no-restricted-properties -- zero-dependency leaf; corrupt shipped data must throw with its offset
	return (await readLocalJSONFile(path)) as T
}
