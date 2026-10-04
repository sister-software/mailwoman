/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Natural Earth's 1:10m admin-0 map units, the polygons the jurisdiction coverage layer fills.
 *
 *   Natural Earth is public domain, so the polygons may be baked into published tiles. The layer reads
 *   the map-units file rather than the countries file because map units give the French overseas
 *   departments, the US Minor Outlying Islands and Taiwan polygons of their own. The countries file
 *   folds the five departments into France.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { streamToDisk } from "@mailwoman/core/utils"
import { dirname, type PathBuilder } from "path-ts"

/**
 * The Natural Earth release the layer is built from, a tag of `nvkelso/natural-earth-vector`.
 */
export const NATURAL_EARTH_RELEASE = "v5.1.2"

/**
 * The map-units GeoJSON file within a Natural Earth release.
 */
export const NATURAL_EARTH_MAP_UNITS_FILE = "ne_10m_admin_0_map_units.geojson"

/**
 * The properties of a Natural Earth map unit that the jurisdiction code is read from.
 */
export interface NaturalEarthUnitProperties {
	ISO_A2: string
	ISO_A2_EH: string
	ADM0_A3: string
	NAME: string
}

/**
 * One Natural Earth map unit as GeoJSON.
 */
export interface NaturalEarthUnit {
	type: "Feature"
	properties: NaturalEarthUnitProperties
	geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown }
}

/**
 * The record written beside a downloaded release file: where it came from and the bytes it holds.
 */
export interface NaturalEarthReceipt {
	release: string
	file: string
	url: string
	sha256: string
	bytes: number
	fetchedAt: string
	license: "public domain"
}

/**
 * The local path of a Natural Earth release file under the data root.
 */
export function naturalEarthPath(file: string, release = NATURAL_EARTH_RELEASE): PathBuilder {
	return dataRootPath("natural-earth", release, file)
}

/**
 * Downloads one Natural Earth release file and writes its receipt, or returns the path
 * when the file is already present.
 */
export async function fetchNaturalEarthFile(
	file: string = NATURAL_EARTH_MAP_UNITS_FILE,
	release: string = NATURAL_EARTH_RELEASE
): Promise<PathBuilder> {
	const destination = naturalEarthPath(file, release)

	if (await pathExists(destination)) return destination

	const url = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${release}/geojson/${file}`

	await makeDirectories(dirname(destination))

	const bytes = await streamToDisk({ url, destination, context: `Natural Earth ${release} ${file}` })

	const receipt: NaturalEarthReceipt = {
		release,
		file,
		url,
		sha256: await sha256File(destination),
		bytes,
		fetchedAt: new Date().toISOString(),
		license: "public domain",
	}

	await writeLocalJSONFile(receipt, naturalEarthPath(`${file}.receipt.json`, release))

	return destination
}

/**
 * Returns the ISO 3166-1 alpha-2 code a map unit stands for, or `undefined` for a unit no jurisdiction owns.
 *
 * `ISO_A2` holds `-99` for France and Norway and a subdivision code such as `FR-973`
 * for French Guiana, so the code is read from `ISO_A2_EH`.
 * The US Minor Outlying Islands carry `ISO_A2_EH` `US` and are told apart by `ADM0_A3` `UMI`.
 *
 * A disputed or special area, such as Bir Tawil or the Cyprus buffer zone, carries `-99` in both fields.
 */
export function mapUnitJurisdiction(properties: NaturalEarthUnitProperties): string | undefined {
	if (properties.ADM0_A3 === "UMI") return "UM"

	const code = properties.ISO_A2_EH === "-99" ? properties.ISO_A2 : properties.ISO_A2_EH

	return /^[A-Z]{2}$/u.test(code) ? code : undefined
}

/**
 * Reads the map units of a downloaded release.
 */
export async function readNaturalEarthMapUnits(path: PathBuilder): Promise<NaturalEarthUnit[]> {
	const collection = await readLocalJSONFile<{ features: NaturalEarthUnit[] }>(path)

	return collection.features
}
