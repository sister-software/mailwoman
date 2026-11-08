// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Where a country's address-layer files live, how a country is split into them, and the manifest that lists them.
 *
 *   Each file sits under a dated prefix, `addresses/<region>/<version>/`, and is never overwritten. A reader learns a
 *   country's files from its manifest, `addresses/<cc>/<version>/manifest.json`, so code holds no list of countries
 *   or subdivisions.
 */

import { readLocalJSONFile, sortedGlob } from "@mailwoman/core/fs/readers"
import { pathExists, statPath } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { type RecordedFile, sha256File } from "@mailwoman/core/hash"
import { relative, resolvePathBuilder, type PathBuilder, type PathBuilderLike } from "path-ts"

/**
 * The row count above which a country is written one file per first-level subdivision.
 *
 * At 10 M, France (26.0 M rows) and Germany (20.3 M) split and Taiwan (9.7 M) does not.
 */
export const ADDRESS_LAYER_SPLIT_ROWS = 10_000_000

/**
 * One file set of a country's address layer: the whole country, or one of its subdivisions.
 */
export interface AddressLayerRegion {
	/**
	 * The region's path segment: the lower-case ISO 3166-1 code (`tw`), or the
	 * lower-case ISO 3166-2 code of a subdivision (`us-wi`).
	 */
	region: string
	/**
	 * The ISO 3166-2 code the region's records hold, or `null` for a whole-country file.
	 */
	subdivision: string | null
	records: number
}

/**
 * The files a country's address layer is written as, from its record count per subdivision.
 *
 * A country above `threshold` rows is written one file per subdivision.
 * Records without a subdivision then go to a file of the country's own.
 * A country at or below the threshold is one file.
 *
 * @param bySubdivision Records per ISO 3166-2 code, with `null` for records that state none.
 */
export function planAddressLayerRegions(
	country: string,
	bySubdivision: ReadonlyMap<string | null, number>,
	threshold = ADDRESS_LAYER_SPLIT_ROWS
): AddressLayerRegion[] {
	const cc = country.toLowerCase()
	let total = 0

	for (const count of bySubdivision.values()) {
		total += count
	}

	if (total <= threshold) return [{ region: cc, subdivision: null, records: total }]

	return [...bySubdivision]
		.map(([subdivision, records]) => ({
			region: subdivision ? subdivision.toLowerCase() : cc,
			subdivision,
			records,
		}))
		.toSorted((left, right) => left.region.localeCompare(right.region))
}

/**
 * The two files of one region at one version, under `root`.
 */
export function addressLayerFiles(
	root: PathBuilderLike,
	region: string,
	version: string
): { lookup: PathBuilder; detail: PathBuilder } {
	const directory = resolvePathBuilder(root, "addresses", region, version)

	return { lookup: directory("lookup.db"), detail: directory("detail.db") }
}

/**
 * Where a country's manifest for one version lives, under `root`.
 */
export function addressLayerManifestPath(root: PathBuilderLike, country: string, version: string): PathBuilder {
	return resolvePathBuilder(root, "addresses", country.toLowerCase(), version, "manifest.json")
}

/**
 * A country's address-layer manifest for one version.
 *
 * Each file is listed by its path relative to the layer root.
 */
export interface AddressLayerCountryManifest {
	country: string
	version: string
	/**
	 * The split threshold the build applied, so a reader sees why a country is one file or several.
	 */
	splitRows: number
	/**
	 * The most distinct addresses one source could place at one point before the build refused them.
	 */
	stackLimit?: number
	/**
	 * The duplicate rule the build dropped repeated records by: the source ranking it applied,
	 * highest first, and the distance and stacked-point limits of `isDuplicateAddress`.
	 */
	duplicateRule?: { ranking: readonly string[]; distanceKm: number; stackLimit: number }
	regions: Array<
		AddressLayerRegion & {
			lookup: RecordedFile
			detail: RecordedFile
			/**
			 * Records the build left out of the region, per source id and reason.
			 */
			refused?: Record<string, Record<string, number>>
		}
	>
}

/**
 * One built file's path relative to `root`, its size and its SHA-256, for the manifest.
 */
export async function describeAddressLayerFile(root: PathBuilderLike, path: PathBuilderLike): Promise<RecordedFile> {
	const [stats, sha256] = await Promise.all([statPath(path), sha256File(path)])

	return { path: relative(root, path).toString(), bytes: stats.size, sha256 }
}

/**
 * The newest manifest a country's address layer holds under `root`, by its dated
 * version directory, or `null` when the country has no layer there.
 */
export async function readLatestAddressLayerManifest(
	root: PathBuilderLike,
	country: string
): Promise<AddressLayerCountryManifest | null> {
	const countryDir = resolvePathBuilder(root, "addresses", country.toLowerCase())

	if (!(await pathExists(countryDir))) return null

	// Versions are ISO dates, so code-point order is date order and the last manifest is the newest.
	const newest = (await sortedGlob(countryDir, "*/manifest.json")).at(-1)

	return newest ? readLocalJSONFile<AddressLayerCountryManifest>(newest) : null
}

/**
 * Writes a country's manifest beside its files, after every region it lists is built.
 */
export async function writeAddressLayerManifest(
	root: PathBuilderLike,
	manifest: AddressLayerCountryManifest
): Promise<PathBuilder> {
	const path = addressLayerManifestPath(root, manifest.country, manifest.version)

	await writeLocalJSONFile<AddressLayerCountryManifest>(manifest, path)

	return path
}
