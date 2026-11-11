/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Rounds GeoJSON coordinates to a fixed number of decimal places.
 *
 *   A coordinate rounded to `d` places moves by at most half of 10^-d degrees. At six places that bound is 0.0000005
 *   degrees, or 0.056 m north–south.
 */

import { isCoordPairLiteral } from "#position"

/**
 * A coordinate rounded to `decimals` places.
 * Negative zero becomes zero.
 */
export function roundCoordinate(value: number, decimals: number): number {
	const factor = 10 ** decimals
	const rounded = Math.round(value * factor) / factor

	return Object.is(rounded, -0) ? 0 : rounded
}

/**
 * What {@link roundGeometryCoordinates} produced.
 */
export interface RoundedCoordinates {
	/**
	 * The coordinates array, with every position rounded and the nesting unchanged.
	 */
	coordinates: unknown
	/**
	 * Whether two neighboring positions of a ring or line became equal that differed before.
	 *
	 * The rounded geometry then holds a repeated vertex the source didn't.
	 */
	collapsed: boolean
}

/**
 * Round every position of a GeoJSON `coordinates` array, of any geometry type, to `decimals` places.
 */
export function roundGeometryCoordinates(coordinates: unknown, decimals: number): RoundedCoordinates {
	let collapsed = false

	const walk = (value: unknown): unknown => {
		if (isCoordPairLiteral(value)) return value.map((coordinate) => roundCoordinate(coordinate, decimals))

		if (!Array.isArray(value)) return value

		const items = value.map(walk)

		// A sequence of positions is a ring or a line.
		// Equal neighbors after rounding that differed before collapsed.
		if (value.length > 1 && value.every(isCoordPairLiteral)) {
			for (let i = 1; i < items.length; i++) {
				const after = [items[i - 1] as number[], items[i] as number[]]
				const before = [value[i - 1] as number[], value[i] as number[]]

				const equalAfter = after[0]!.every((n, k) => n === after[1]![k])
				const equalBefore = before[0]!.every((n, k) => n === before[1]![k])

				if (equalAfter && !equalBefore) {
					collapsed = true
				}
			}
		}

		return items
	}

	return { coordinates: walk(coordinates), collapsed }
}
