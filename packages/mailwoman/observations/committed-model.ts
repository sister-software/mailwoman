/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The committed compiled geographic model, read once for whichever observation route asks.
 */

import type { CompiledGeographicModel } from "@mailwoman/geographic-model"

/**
 * The committed compiled artifact, read through the package that owns it. Never the authoring records: the runtime side
 * of this program consumes an artifact, and traversing authoring JSON is what the boundary record excludes. The import
 * is dynamic so the authoring scripts stay off the default construction path.
 */
export async function readCommittedModel(): Promise<CompiledGeographicModel> {
	const { readCompiledGeographicModel } = await import("@mailwoman/geographic-model/scripts/build-artifact")

	return await readCompiledGeographicModel()
}
