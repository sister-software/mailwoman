/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The FST artifacts a parse reads, through the active selection: the per-locale gazetteer FST and the
 *   street-morphology FST. A data root whose selection lists neither reads the files beside the weights,
 *   as it did before the selection existed.
 */

import { ArtifactFormat, ServingRole } from "@mailwoman/core/layers"
import type { PathBuilderLike } from "path-ts"

import { LayerCatalog } from "#data/catalog"
import type { ParsePriorArtifacts } from "#geocode/parse-priors"

/**
 * The selection scope of a locale's gazetteer FST: the locale's country, such as `US` for `en-US`.
 *
 * A locale without a region subtag reads the unscoped entry.
 */
export function gazetteerFSTScope(locale: string): { country: string | null; subdivision: null } {
	const region = locale.split("-")[1]

	return { country: region ? region.toUpperCase() : null, subdivision: null }
}

/**
 * The gazetteer FST the active selection lists for a locale, or `null` when it lists none.
 *
 * @throws {@link UnreadableArtifactError} when the selection or the selected FST cannot be read.
 */
export async function selectedGazetteerFSTPath(
	locale: string,
	dataRoot: PathBuilderLike,
	catalog?: LayerCatalog
): Promise<string | null> {
	const snapshot = catalog ?? (await LayerCatalog.read(dataRoot))

	return snapshot.firstPath(ServingRole.GazetteerFST, gazetteerFSTScope(locale))
}

/**
 * The street-morphology FST the active selection lists, or `null` when it lists none.
 *
 * The entry may list the FST with the files built beside it.
 * The first source in FST format is the matcher.
 *
 * @throws {@link UnreadableArtifactError} when the selection or the selected FST cannot be read.
 */
export async function selectedStreetMorphologyPath(
	dataRoot: PathBuilderLike,
	catalog?: LayerCatalog
): Promise<string | null> {
	const snapshot = catalog ?? (await LayerCatalog.read(dataRoot))

	return snapshot.firstPath(
		ServingRole.StreetMorphology,
		{ country: null, subdivision: null },
		(manifest) => manifest.format === ArtifactFormat.FST
	)
}

/**
 * The prior artifacts a classifier's parse reads: each FST the active selection lists,
 * else the classifier's own file beside its weights.
 *
 * The postcode-prefix indexes are read as the classifier states them.
 *
 * @param catalog One reading of the active selection, read from `dataRoot` when omitted.
 * @throws {@link UnreadableArtifactError} when the selection or a selected FST cannot be read.
 */
export async function selectedParsePriorArtifacts(
	artifacts: ParsePriorArtifacts,
	locale: string,
	dataRoot: PathBuilderLike,
	catalog?: LayerCatalog
): Promise<ParsePriorArtifacts> {
	const snapshot = catalog ?? (await LayerCatalog.read(dataRoot))
	const fstPath = await selectedGazetteerFSTPath(locale, dataRoot, snapshot)
	const streetMorphologyPath = await selectedStreetMorphologyPath(dataRoot, snapshot)

	return {
		fstPath: fstPath ?? artifacts.fstPath,
		streetMorphologyPath: streetMorphologyPath ?? artifacts.streetMorphologyPath,
		postcodePrefixPaths: artifacts.postcodePrefixPaths,
	}
}
