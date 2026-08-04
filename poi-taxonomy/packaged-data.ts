/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Locating the package's own shipped `data/` tables. Node-only — the browser-safe `./table` entry
 *   takes its table from the caller and never reaches the filesystem.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

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
 */
export function resolvePackagedDataPath(filename: string): string {
	const candidates = [resolve(moduleDir, "data", filename), resolve(moduleDir, "..", "data", filename)]
	const found = candidates.find((candidate) => existsSync(candidate))

	if (!found) {
		throw new Error(`poi-taxonomy: could not find data/${filename} — looked in ${candidates.join(", ")}`)
	}

	return found
}

/**
 * Read and parse one of the package's shipped `data/` tables.
 */
export function readPackagedTable<T>(filename: string): T {
	const path = resolvePackagedDataPath(filename)

	// A corrupt shipped table is a broken build, and the SyntaxError names the offset. `poi-taxonomy` declares zero
	// dependencies, so `@mailwoman/core`'s parse wrappers are deliberately out of reach.
	// oxlint-disable-next-line no-restricted-properties
	return JSON.parse(readFileSync(path, "utf8")) as T
}
