/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Locating a data-only package's shipped `data/` files. `data/` sits at the package root (it is a `files` entry),
 *   and the calling module sits either at that root — running from source — or one level down under `out/` when
 *   compiled, so there are exactly two places to look. The probe tests for the FILE: probing by attempting a parse
 *   folds a corrupt table into "not this candidate", and the package then reports a missing table it is looking
 *   straight at.
 */

import { resolvePath } from "path-ts"

import { pathExists } from "#fs/readers"

/**
 * Absolute path to `data/<filename>`, probed from `moduleDir` — the source-tree candidate first, then the compiled
 * `out/` sibling.
 *
 * @throws When neither candidate exists, naming both probed paths.
 */
export async function resolvePackagedDataPath(moduleDir: string, filename: string): Promise<string> {
	const candidates = [resolvePath(moduleDir, "data", filename), resolvePath(moduleDir, "..", "data", filename)]

	for (const candidate of candidates) {
		if (await pathExists(candidate)) return candidate
	}

	throw new Error(`could not find data/${filename} — looked in ${candidates.join(", ")}`)
}
