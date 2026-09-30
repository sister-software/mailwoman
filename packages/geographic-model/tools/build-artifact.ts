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

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"

import type { CompiledGeographicModel } from "#artifact"
import { compileGeographicModel } from "#compile"
import { loadGeographicModelDirectory } from "#load"
import { packagedModelPaths } from "#packaged"

/**
 * The command that rewrites the committed artifact, quoted by the freshness test's
 * failure message so a reader who trips it is told what to run.
 */
export const REGENERATE_ARTIFACT_COMMAND =
	"node packages/geographic-model/tools/build-artifact.ts && npx oxfmt packages/geographic-model/data/geographic-model.json"

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
