/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The US address skeletons the OA-shaped recipes read: two elected OpenAddresses extracts and one
 *   National Address Database sample per chosen state, with Vermont held out for the golden sets.
 *
 *   `unit`, `street-affix`, `suffix-boundary`, `po-box-cedex` and `country-balanced` read these files
 *   through the same zipped-CSV reader, so a NAD sample is written in OpenAddresses' column layout by
 *   `packages/mailwoman/tools/dev-tools/corpus/nad-skeletons.run.ts`.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import type { PathBuilderLike } from "path-ts"

/**
 * The register a skeleton file's rows were published in.
 *
 * It prefixes the `base_source_id` a recipe derives from the file.
 */
export const USSkeletonRegister = {
	OpenAddresses: "openaddresses",
	NationalAddressDatabase: "usgov-nad",
} as const

export type USSkeletonRegister = (typeof USSkeletonRegister)[keyof typeof USSkeletonRegister]

/**
 * One cached US skeleton file: the zip, its CSV member and the region every row of it lies in.
 */
export interface USSkeletonSource {
	zip: PathBuilderLike
	csv: string
	region: string
	register: USSkeletonRegister
}

/**
 * The data-root directory holding the NAD samples and ZIP-to-city tables the NAD skeleton tool writes.
 */
export const NAD_SKELETON_DIRECTORY = "nad-skeletons"

/**
 * The states sampled from NAD, chosen for address shapes the OpenAddresses files lack
 * rather than for row count.
 *
 * Distinct tuples of those six files carry a unit on 0.6% of rows, and none has
 * a hyphenated or direction-prefixed house number.
 *
 * Each comment states the shape measured over the usable rows of the FeatureServer
 * pages fetched on 2026-05-18.
 * `nad-skeletons.run.ts` prints the table for every state.
 *
 * Vermont is absent because it is the eval holdout.
 * No state's rows match a rural-route street pattern, so NAD adds no rural-route form.
 */
export const NAD_SKELETON_STATES = [
	// Chicago's city grid, which `us/il/cook` supplied before it was withdrawn: 8.9% unit, 1,268 ZIPs.
	"IL",
	// 36.6% unit, the most of any state with over a million rows, and 154 street types.
	"MA",
	// The numbered grid: 43.1% numeric street names and 42.6% post-directionals, as in `500 E`.
	"UT",
	// Direction-prefixed rural grid house numbers such as `S9878` on 1.3% of rows, and lettered county roads.
	"WI",
	// Hyphenated Queens house numbers such as `244-32` on 5.3% of rows, and 15.8% unit.
	"NY",
	// Farm to Market, Ranch Road and County Road prefix types on 5.4% of rows, and 161 street types.
	"TX",
] as const

/**
 * The zip and CSV member the NAD skeleton tool writes for one state.
 */
export function nadSkeletonFile(region: string): { zip: PathBuilderLike; csv: string } {
	const state = region.toLowerCase()

	return {
		zip: dataRootPath(NAD_SKELETON_DIRECTORY, `us__${state}__nad.zip`),
		csv: `us/${state}/nad.csv`,
	}
}

/**
 * The NAD skeleton file for every state in {@link NAD_SKELETON_STATES}.
 */
export const NAD_SKELETON_SOURCES: readonly USSkeletonSource[] = NAD_SKELETON_STATES.map((region) => ({
	...nadSkeletonFile(region),
	region,
	register: USSkeletonRegister.NationalAddressDatabase,
}))

/**
 * The cached OpenAddresses US extracts used for training.
 *
 * `us/il/cook` is absent because Cook County's terms restrict redistribution.
 * NAD's Illinois sample stands in for its city grid.
 */
export const OA_SKELETON_TRAIN_SOURCES: readonly USSkeletonSource[] = (
	[
		["us__ca__berkeley.zip", "us/ca/berkeley.csv", "CA"],
		["us__ca__marin.zip", "us/ca/marin.csv", "CA"],
		["us__dc__statewide.zip", "us/dc/statewide.csv", "DC"],
		["us__ia__statewide.zip", "us/ia/statewide.csv", "IA"],
		["us__mt__statewide.zip", "us/mt/statewide.csv", "MT"],
		["us__sd__statewide.zip", "us/sd/statewide.csv", "SD"],
	] as const
).map(([zip, csv, region]) => ({
	zip: dataRootPath("oa-cache", zip),
	csv,
	region,
	register: USSkeletonRegister.OpenAddresses,
}))

/**
 * Every US training skeleton: the OpenAddresses extracts and the NAD samples.
 */
export const US_SKELETON_TRAIN_SOURCES: readonly USSkeletonSource[] = [
	...OA_SKELETON_TRAIN_SOURCES,
	...NAD_SKELETON_SOURCES,
]

/**
 * Vermont, the corpus holdout — `--golden` reads this and no other US source.
 */
export const US_SKELETON_EVAL_SOURCE: USSkeletonSource = {
	zip: dataRootPath("oa-cache", "us__vt__statewide.zip"),
	csv: "us/vt/statewide.csv",
	region: "VT",
	register: USSkeletonRegister.OpenAddresses,
}

/**
 * A county whose NAD rows give the ZIP-to-city table the `intersection` recipe renders city tails from.
 */
export interface NADZipCityCounty {
	region: string
	county: string
}

/**
 * The counties of the `intersection` recipe's TIGER training crossings, Cook IL and Morris NJ.
 */
export const NAD_ZIP_CITY_COUNTIES: readonly NADZipCityCounty[] = [
	{ region: "IL", county: "Cook" },
	{ region: "NJ", county: "Morris" },
]

/**
 * The ZIP-to-city CSV the NAD skeleton tool writes for one county.
 */
export function nadZipCityPath(entry: NADZipCityCounty): PathBuilderLike {
	const county = entry.county.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")

	return dataRootPath(NAD_SKELETON_DIRECTORY, `us__${entry.region.toLowerCase()}__${county}__zip-city.csv`)
}
