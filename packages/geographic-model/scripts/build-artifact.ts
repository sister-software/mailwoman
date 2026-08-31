/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generator for `data/geographic-model.json` — the committed compiled artifact, built from the
 *   authored records under `data/model/`.
 *
 *   The build step is the whole of what this file does: load the authoring directory, compile it,
 *   serialize the result. Every decision inside those three calls belongs to `../load.ts`,
 *   `../compile.ts` and `../artifact.ts`, and none of them is re-made here.
 *
 *   **A committed artifact is these bytes run through `oxfmt`.** The repository formatter also formats
 *   committed JSON, and it inlines short arrays, which `JSON.stringify` cannot reproduce. So the
 *   freshness check in `test/unit/pharmacy-slice.test.ts` compares the PARSED artifact against a fresh
 *   compile, and byte equality is asserted between two compiles instead. The same convention holds
 *   `taxonomy.json` in `@mailwoman/poi-taxonomy`; its `data/PROVENANCE.md` states it for that table.
 *
 *   Nothing here reaches `@mailwoman/core`: the package's build project declares no reference to it in
 *   either direction, and a generator is not the reason to reverse that. `import.meta.main` is what
 *   `runIfScript` reads anyway, and reading it directly keeps this file inside the package's own
 *   dependency graph.
 */

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { resolvePath } from "path-ts"

import { type CompiledGeographicModel, parseCompiledGeographicModel } from "#artifact"
import { compileGeographicModel } from "#compile"
import { loadGeographicModelDirectory } from "#load"

/**
 * The command that rewrites the committed artifact. Stated once, and quoted by the freshness test's failure message, so
 * a reader who trips it is told what to run rather than left to reconstruct it.
 */
export const REGENERATE_ARTIFACT_COMMAND =
	"node packages/geographic-model/scripts/build-artifact.ts && npx oxfmt packages/geographic-model/data/geographic-model.json"

/**
 * The authoring directory and the artifact it compiles to.
 *
 * Two candidates, because this module runs from two places: `scripts/` in the repository, where `data/` is one level
 * up, and `out/scripts/` in a published tarball, where it is two. Probing for the file distinguishes those from a
 * genuinely missing `data/`, which throws with both paths named.
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
 * Load the authored records and compile them. Throws with every violation if they do not load, and with every reason if
 * they load but do not compile; nothing partial is returned.
 */
export async function compileAuthoredGeographicModel(): Promise<CompiledGeographicModel> {
	const { source } = await packagedModelPaths()

	return compileGeographicModel(await loadGeographicModelDirectory(source))
}

/**
 * Read the committed artifact. The format version is checked; the records are not re-validated, because they were
 * validated on the way in.
 */
export async function readCompiledGeographicModel(): Promise<CompiledGeographicModel> {
	const text = await readLocalTextFile((await packagedModelPaths()).artifact)

	// A corrupt committed artifact is a broken build, and the `SyntaxError` names the offset. The package's parse
	// wrappers live in `@mailwoman/core`, which this package deliberately does not depend on.
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

// `import.meta.main` is undefined under a Vite/vitest module graph, so importing this module from a test stays
// side-effect-free and never rewrites the committed artifact.
if (import.meta.main) {
	await main()
}
