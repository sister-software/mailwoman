/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The county or unitary authority of a GB postcode, read from the unit-postcode entries of OS Open Names.
 *
 *   A GB address commonly ends its locality with a county, as in `King's Lynn, Norfolk` or
 *   `38 High Street, Maidstone, Kent ME14 1JH`. The rows a corpus renders from `gb-os-open` take their
 *   region from {@link openConstituentCountryReader}, which answers England, Scotland or Wales, so a model
 *   A model trained only on these rows sees no county in the region position and reads `Norfolk` as a locality.
 *   OS Open Names publishes one entry per unit postcode with its `COUNTY_UNITARY`, under the same
 *   Open Government Licence as the other two products the adapter reads.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { GB_OS_OPEN_ADAPTER_ID, GB_OS_OPEN_PRODUCT_DIRECTORIES } from "#gb/adapters/os-open/adapter"
import { createOpenNamesReadStats, readOpenNamesPostcodeCounties } from "#gb/os-open/open/names"

/**
 * The Open Names product the `gb-os-open` fetch writes under the data root.
 */
export function gbOpenNamesDirectory(): PathBuilder {
	return dataRootPath("corpus", "sources", GB_OS_OPEN_ADAPTER_ID, GB_OS_OPEN_PRODUCT_DIRECTORIES.openNames)
}

/**
 * Reads every unit postcode of OS Open Names and returns a map from the postcode
 * to its county or unitary authority.
 *
 * A postcode whose entry names no county is left out of the map.
 *
 * @throws When the directory holds no `Data/*.csv`, so a missing product reports itself
 * rather than reading as a map with no county.
 */
export async function readCountyOfPostcode(
	openNamesDirectory: PathBuilderLike = gbOpenNamesDirectory()
): Promise<Map<string, string>> {
	const directory = PathBuilder.from(openNamesDirectory)
	const files = await Globerator.from("Data/*.csv", { cwd: directory.toString(), absolute: false }).toSorted()

	if (!files.length) throw new Error(`${directory.toString()} holds no Data/*.csv`)

	const stats = createOpenNamesReadStats()
	const counties = new Map<string, string>()

	for (const file of files) {
		for await (const entry of readOpenNamesPostcodeCounties(directory(file).toString(), stats)) {
			if (entry.countyUnitary) {
				counties.set(entry.postcode, entry.countyUnitary)
			}
		}
	}

	return counties
}
