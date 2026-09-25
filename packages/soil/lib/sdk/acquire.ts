/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Downloads a region's soil survey areas and turns them into builder inputs.
 *
 *   The catalogue's `saverest` date decides which archive to download and also appears in the archive's
 *   filename. The download host rejects `HEAD` and ignores `Range`, so it cannot answer freshness cheaply.
 */

import type { PathBuilderLike } from "path-ts"

import type { SurveyAreaInput } from "#sdk/build-soil"
import type { SoilDataAccessClient, SurveyAreaCatalogEntry } from "#sdk/client"
import { downloadSurveyArea, type SurveyAreaArchive } from "#sdk/download"
import { mapUnitShapefile, readSoilSourceIdentity, surveyAreaShapefile } from "#sdk/ingest/index"
import { readSurveyAreaAttributes, readSurveyAreaOutline } from "#sdk/survey-area"

/**
 * Options for {@link acquireRegion}.
 */
export interface AcquireRegionOptions {
	client: SoilDataAccessClient
	/**
	 * The survey-area symbol prefix.
	 *
	 * A state code such as `IA` selects a whole state, and a full symbol such as `IA153` selects one area.
	 */
	prefix: string
	/**
	 * The directory where downloaded archives are cached.
	 */
	cacheRoot: PathBuilderLike
	/**
	 * The symbols to build from the catalogue's results.
	 * When it is absent, every symbol is built.
	 */
	only?: ReadonlyArray<string>
	onProgress?: (message: string) => void
}

/**
 * The result of acquiring one region.
 */
export interface AcquiredRegion {
	catalog: SurveyAreaCatalogEntry[]
	archives: SurveyAreaArchive[]
	areas: SurveyAreaInput[]
	/**
	 * The latest `saverest` date among the areas built, used as the artifact's source vintage.
	 */
	sourceVintage: string
}

/**
 * Downloads every survey area that matches the prefix and turns each into a builder input.
 *
 * @throws {Error} When the catalogue has no entry for the prefix, when `only` lists a symbol
 * that the catalogue lacks, or when an area's archive, metadata or shapefile cannot be read.
 */
export async function acquireRegion(options: AcquireRegionOptions): Promise<AcquiredRegion> {
	const catalog = await options.client.readSurveyAreaCatalog(options.prefix)
	const wanted = options.only ? new Set(options.only.map((symbol) => symbol.toUpperCase())) : undefined

	const selected = wanted ? catalog.filter((entry) => wanted.has(entry.areasymbol.toUpperCase())) : catalog

	if (wanted) {
		const found = new Set(selected.map((entry) => entry.areasymbol.toUpperCase()))
		const missing = [...wanted].filter((symbol) => !found.has(symbol))

		if (missing.length) {
			throw new Error(
				`soil acquire: the catalogue holds no survey area named ${missing.join(", ")} — building the rest would quietly answer a smaller question than the one asked`
			)
		}
	}

	options.onProgress?.(`${selected.length} survey area(s) from the catalogue`)

	const archives: SurveyAreaArchive[] = []
	const areas: SurveyAreaInput[] = []

	for (const entry of selected) {
		const archive = await downloadSurveyArea({
			areaSymbol: entry.areasymbol,
			versionDate: entry.saverest,
			cacheRoot: options.cacheRoot,
			...(options.onProgress ? { onProgress: options.onProgress } : {}),
		})

		archives.push(archive)

		const attributes = await readSurveyAreaAttributes(archive.tabularDirectory, entry.areasymbol)
		const shapefilePath = mapUnitShapefile(archive.spatialDirectory, entry.areasymbol)
		const identity = await readSoilSourceIdentity({ shapefilePath })
		const outline = await readSurveyAreaOutline(surveyAreaShapefile(archive.spatialDirectory, entry.areasymbol))

		options.onProgress?.(
			`${entry.areasymbol}: ${identity.featureCount.toLocaleString()} delineations · ${attributes.mapUnits.length} map units · ` +
				`${attributes.components.length} components · refresh ${attributes.saverest} · field survey ${attributes.surveySourceDate ?? "unstated"}`
		)

		areas.push({
			attributes,
			shapefilePath,
			outline,
			declaredFeatureCount: identity.featureCount,
		})
	}

	// The latest refresh date is the date after which no entry in this artifact changed.
	const sourceVintage = selected
		.map((entry) => entry.saverest)
		.toSorted()
		.at(-1)!

	return { catalog, archives, areas, sourceVintage }
}
