/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The input checks the map model shares. An input the model cannot use throws {@link MapInputError},
 *   whose `path` locates the input, such as `paths[shared-trench].coordinates`.
 */

import type { Coordinates2D } from "@mailwoman/spatial"
import { isValidLatitude, isValidLongitude } from "@mailwoman/spatial/coordinate/bounds"

/**
 * An input the map model cannot use.
 *
 * `path` locates the input, and the message states why the model refuses it.
 */
export class MapInputError extends Error {
	readonly path: string

	constructor(path: string, message: string) {
		super(`${path}: ${message}`)
		this.name = "MapInputError"
		this.path = path
	}
}

/**
 * Throws {@link MapInputError} unless `coordinates` holds at least two positions,
 * each a longitude from -180 to 180 and a latitude from -90 to 90 degrees.
 */
export function checkLineCoordinates(coordinates: readonly Coordinates2D[], path: string): void {
	if (coordinates.length < 2) {
		throw new MapInputError(`${path}.coordinates`, "a line needs at least two positions")
	}

	for (const [index, [longitude, latitude]] of coordinates.entries()) {
		if (!isValidLongitude(longitude) || !isValidLatitude(latitude)) {
			throw new MapInputError(
				`${path}.coordinates[${index}]`,
				`longitude ${longitude} and latitude ${latitude} lie outside -180 to 180 and -90 to 90 degrees`
			)
		}
	}
}
