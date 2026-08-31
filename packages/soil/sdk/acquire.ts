/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Acquisition, end to end: which survey areas a region holds, their archives, and the inputs the builder
 *   takes.
 *
 *   THE FRESHNESS QUESTION IS ANSWERED BY THE TABULAR SERVICE, NOT BY THE FILE HOST. `sacatalog.saverest` is
 *   the version-established date, and it is also what the archive's filename embeds — so one catalogue call
 *   both decides what to download and names the file. The download host cannot answer it: it refuses `HEAD`
 *   with 405 and ignores `Range`, so a length probe there is a full transfer.
 *
 *   THE VINTAGE IS THE REFRESH THE BUILD INGESTED, AND IT IS ONE DATE FOR THE WHOLE ARTIFACT. NRCS performs
 *   ONE coordinated Annual Soils Refresh, each October 1; grouping `sacatalog` by year of `saverest` returns
 *   2016: 1, 2025: 3,323, 2026: 56. So a region's areas share a refresh and the manifest can carry one
 *   `source_vintage` — the LATEST of the areas built, because that is the date after which nothing in the
 *   artifact changed. Every area's own date is kept per row in `soil_survey_area`, and so is the far older
 *   field-survey date, which is the number a currency claim actually turns on.
 */

import type { SurveyAreaInput } from "#sdk/build-soil"
import type { SoilDataAccessClient, SurveyAreaCatalogEntry } from "#sdk/client"
import { downloadSurveyArea, type SurveyAreaArchive } from "#sdk/download"
import { mapUnitShapefile, readSoilSourceIdentity, surveyAreaShapefile } from "#sdk/ingest"
import { readSurveyAreaAttributes, readSurveyAreaOutline } from "#sdk/survey-area"

export interface AcquireRegionOptions {
	client: SoilDataAccessClient
	/**
	 * The survey-area symbol prefix — a state code (`IA`) for a whole state, or a full symbol (`IA153`) for the
	 * single-area rung.
	 */
	prefix: string
	/**
	 * Where vintages are kept.
	 */
	cacheRoot: string
	/**
	 * Build only these symbols out of the ones the catalogue returns. Absent means all of them.
	 */
	only?: ReadonlyArray<string>
	onProgress?: (message: string) => void
}

/**
 * What one region's acquisition produced.
 */
export interface AcquiredRegion {
	catalog: SurveyAreaCatalogEntry[]
	archives: SurveyAreaArchive[]
	areas: SurveyAreaInput[]
	/**
	 * The refresh the artifact carries — the latest version date among the areas built.
	 */
	sourceVintage: string
}

/**
 * Acquire every survey area a prefix names, and turn them into builder inputs.
 *
 * @throws {Error} When the catalogue holds nothing for the prefix, when `only` names a symbol the catalogue does not
 *   carry, or when any area's archive, metadata or shapefile refuses.
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

	// The LATEST refresh among the areas built, because that is the date after which nothing in this artifact changed.
	// Taking the earliest would claim a currency the newest area does not have; taking today's date would claim one no
	// area has.
	const sourceVintage = selected
		.map((entry) => entry.saverest)
		.toSorted()
		.at(-1)!

	return { catalog, archives, areas, sourceVintage }
}
