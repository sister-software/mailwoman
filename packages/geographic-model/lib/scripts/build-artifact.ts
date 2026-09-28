/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Generator for `data/geographic-model.json` — the committed compiled artifact, built from the
 * authored records under `data/model/`.
 *
 * A committed artifact is these bytes run through `oxfmt`, which inlines short arrays that
 * `JSON.stringify` cannot reproduce, so the freshness check compares the parsed artifact against a
 * fresh compile and asserts byte equality between two compiles instead.
 */

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { resolvePath } from "path-ts"

import { type CompiledGeographicModel, parseCompiledGeographicModel } from "#artifact"
import { compileGeographicModel } from "#compile"
import { loadGeographicModelDirectory } from "#load"

/**
 * The command that rewrites the committed artifact, quoted by the freshness test's
 * failure message so a reader who trips it is told what to run.
 */
export const REGENERATE_ARTIFACT_COMMAND =
	"node packages/geographic-model/lib/scripts/build-artifact.ts && npx oxfmt packages/geographic-model/data/geographic-model.json"

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
 * Load the authored records and compile them.
 * No partial result is returned.
 *
 * @throws with every validation violation when the authored tables fail to load.
 * @throws with every compilation issue when loading succeeds but compilation fails.
 */
export async function compileAuthoredGeographicModel(): Promise<CompiledGeographicModel> {
	const { source } = await packagedModelPaths()

	return compileGeographicModel(await loadGeographicModelDirectory(source))
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

async function main(): Promise<void> {
	const { artifact } = await packagedModelPaths()
	const model = await compileAuthoredGeographicModel()

	await writeLocalJSONFile(model, artifact)

	console.log(
		`wrote ${artifact}: ${model.concepts.length} concepts, ${model.relations.length} relations, ${model.mappings.length} mappings, ${model.observations.length} observations, ${model.derivedFacts.length} derived facts (model ${model.modelVersion})`
	)
}

// `import.meta.main` is undefined under a Vite/vitest module graph, so importing this
// module from a test stays side-effect-free and never rewrites the committed artifact.
if (import.meta.main) {
	await main()
}
