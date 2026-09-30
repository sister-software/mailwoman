/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reads the compiled model this package ships in `data/geographic-model.json`.
 */

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { resolvePath } from "path-ts"

import { type CompiledGeographicModel, parseCompiledGeographicModel } from "#artifact"

/**
 * The authoring directory and the artifact it compiles to.
 *
 * Probes for `model/model.json`, so a genuinely missing `data/` throws naming the path.
 */
export async function packagedModelPaths(): Promise<{ source: string; artifact: string }> {
	const candidates = [resolvePackagePath("@mailwoman/geographic-model", "data")]
	const probes: Array<[string, boolean]> = []

	for (const candidate of candidates) {
		probes.push([candidate, await pathExists(resolvePath(candidate, "model/model.json"))])
	}

	const found = probes.find(([, exists]) => exists)?.[0]

	if (!found) {
		throw new Error(`geographic-model: could not find data/model — looked in ${candidates.join(", ")}`)
	}

	return { source: resolvePath(found, "model"), artifact: resolvePath(found, "geographic-model.json") }
}

/**
 * Read the committed artifact.
 *
 * The reader checks the format version.
 * It trusts the records because the loader validated them on input.
 */
export async function readCompiledGeographicModel(): Promise<CompiledGeographicModel> {
	const text = await readLocalTextFile((await packagedModelPaths()).artifact)

	// A corrupt committed artifact is a broken build and the `SyntaxError` names the offset.
	// The package's parse wrappers live in `@mailwoman/core`, which this package deliberately does not depend on.
	// oxlint-disable-next-line no-restricted-properties -- see the note above.
	return parseCompiledGeographicModel(JSON.parse(text))
}
