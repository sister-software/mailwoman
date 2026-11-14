// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { Coordinates2D } from "#position"

/**
 * @file DIGIPIN geographic encoding and decoding.
 *
 * Developed by India Post, Department of Posts.
 *
 * DIGIPIN uses a hierarchical 4×4 grid covering:
 *
 * - Latitude: 2.5° to 38.5°
 * - Longitude: 63.5° to 99.5°
 *
 * Each character represents four bits of spatial information:
 * two latitude bits and two longitude bits.
 *
 * A complete 10-character DIGIPIN represents 40 bits,
 * providing 20-bit resolution along each axis.
 *
 * @see {@link https://en.wikipedia.org/wiki/National_Level_Addressing_Grid | National Level Addressing Grid}
 */

//#region Constants and Lookup Tables

/**
 * DIGIPIN character alphabet, flattened in row-major order from the official 4×4 character grid.
 *
 * Rows are ordered north to south.
 * Columns are ordered west to east.
 */
const ALPHABET = "FC98J327K456LMPT"

/**
 * Southern boundary of the DIGIPIN coverage area, in degrees.
 */
const MIN_LAT = 2.5

/**
 * Northern boundary of the DIGIPIN coverage area, in degrees.
 */
const MAX_LAT = 38.5

/**
 * Western boundary of the DIGIPIN coverage area, in degrees.
 */
const MIN_LON = 63.5

/**
 * Eastern boundary of the DIGIPIN coverage area, in degrees.
 */
const MAX_LON = 99.5

/**
 * Geographic extent of each DIGIPIN axis, in degrees.
 */
const SPAN = 36

/**
 * Number of characters in a complete DIGIPIN.
 *
 * Each character contributes two bits per coordinate axis.
 */
const PRECISION = 10

/**
 * Length of a DIGIPIN in India Post's display form.
 *
 * The display form inserts a hyphen after the third and sixth characters: `39J-49L-L8T4`.
 */
const HYPHENATED_LENGTH = PRECISION + 2

/**
 * String positions of the two hyphens in the display form.
 */
const FIRST_HYPHEN = 3
const SECOND_HYPHEN = 7

/**
 * ASCII code of the hyphen separator.
 */
const HYPHEN = "-".charCodeAt(0)

/**
 * ASCII code range of lowercase Latin letters.
 *
 * The checked decoder folds these letters to uppercase.
 */
const LOWERCASE_A = "a".charCodeAt(0)
const LOWERCASE_Z = "z".charCodeAt(0)

/**
 * Distance from a lowercase ASCII letter to its uppercase form.
 */
const CASE_OFFSET = LOWERCASE_A - "A".charCodeAt(0)

/**
 * Number of subdivisions along each coordinate axis.
 *
 * Ten levels of four-way subdivision produce 4^10 cells along each axis, equivalent to 20 bits.
 */
const RESOLUTION = 1 << 20

/**
 * Maximum zero-based cell index along either axis.
 */
const MAX_INDEX = RESOLUTION - 1

/**
 * Conversion factor from geographic degrees to cell indices.
 */
const SCALE = RESOLUTION / SPAN

/**
 * Geographic width or height of one DIGIPIN cell, in degrees.
 */
const CELL_SIZE = SPAN / RESOLUTION

/**
 * Sentinel value used to identify invalid DIGIPIN characters.
 *
 * Valid character indices range from 0 through 15.
 */
const INVALID = 255

/**
 * ASCII character-to-grid-index lookup table.
 *
 * Each valid uppercase DIGIPIN character maps to its zero-based position in the flattened character grid.
 *
 * All other ASCII characters map to {@link INVALID}.
 *
 * Initialized once at module evaluation.
 * It doesn't cache encoding or decoding results.
 */
const DECODE = buildDecodeTable()

/**
 * Build the ASCII character-to-grid-index lookup table from {@link ALPHABET}.
 */
function buildDecodeTable(): Uint8Array {
	const table = new Uint8Array(128).fill(INVALID)

	for (let i = 0; i < ALPHABET.length; i++) {
		table[ALPHABET.charCodeAt(i)] = i
	}

	return table
}

// #endregion

// #region Public Functions

/**
 * Validate geographic coordinates against DIGIPIN coverage bounds.
 *
 * Both coordinates must be finite numbers within the supported geographic region, including its boundaries.
 *
 * @param latitude - Latitude in WGS 84 degrees.
 * @param longitude - Longitude in WGS 84 degrees.
 *
 * @throws {RangeError} If latitude or longitude is outside DIGIPIN bounds.
 */
export function validateDIGIPINCoordinates(latitude: number, longitude: number): void {
	if (!Number.isFinite(latitude) || latitude < MIN_LAT || latitude > MAX_LAT) {
		throw new RangeError("Latitude out of range")
	}

	if (!Number.isFinite(longitude) || longitude < MIN_LON || longitude > MAX_LON) {
		throw new RangeError("Longitude out of range")
	}
}

/**
 * Encode geographic coordinates into a 10-character DIGIPIN.
 *
 * Coordinates are quantized into 20-bit integer cell indices.
 * Each iteration extracts two bits from each coordinate and combines them into
 * an index into the DIGIPIN alphabet.
 *
 * @param latitude - Latitude in WGS 84 degrees.
 * @param longitude - Longitude in WGS 84 degrees.
 * @returns Uppercase 10-character DIGIPIN.
 *
 * @throws {RangeError} If coordinates are outside DIGIPIN bounds.
 *
 * @example
 * const pin = getDIGIPIN(13.11179621, 80.20264269)
 */
export function getDIGIPIN(latitude: number, longitude: number): string {
	validateDIGIPINCoordinates(latitude, longitude)

	return getDIGIPINUnsafe(latitude, longitude)
}

/**
 * Encode geographic coordinates without validating their bounds.
 *
 * Intended for performance-sensitive batch processing where coordinates have already been validated.
 *
 * Coordinates are quantized into 20-bit indices and encoded using bitwise operations.
 *
 * @param latitude - Latitude in WGS 84 degrees.
 * @param longitude - Longitude in WGS 84 degrees.
 * @returns Uppercase 10-character DIGIPIN.
 *
 * @remarks Inputs must be finite and inside DIGIPIN coverage bounds.
 * Out-of-range inputs produce unspecified results.
 */
export function getDIGIPINUnsafe(latitude: number, longitude: number): string {
	/**
	 * Quantized latitude cell index.
	 */
	const lat = Math.min(MAX_INDEX, Math.floor((latitude - MIN_LAT) * SCALE))

	/**
	 * Quantized longitude cell index.
	 */
	const lon = Math.min(MAX_INDEX, Math.floor((longitude - MIN_LON) * SCALE))

	/**
	 * Encoded DIGIPIN string.
	 */
	let pin = ""

	/**
	 * Extract two bits per axis, beginning with the highest-order bits.
	 */
	for (let shift = 18; shift >= 0; shift -= 2) {
		const row = 3 - ((lat >>> shift) & 3)
		const col = (lon >>> shift) & 3

		pin += ALPHABET[(row << 2) | col]
	}

	return pin
}

/**
 * Decode a DIGIPIN into the center coordinates of its cell.
 *
 * Returns a GeoJSON-compatible position in longitude-first order.
 * Coordinates retain floating-point precision without decimal rounding.
 *
 * @param pin - DIGIPIN to decode, as 10 characters or in the display form `39J-49L-L8T4`.
 * Letters may be lowercase.
 * @returns Cell center as [longitude, latitude].
 *
 * @throws {RangeError} If DIGIPIN has an invalid length or character.
 *
 * @example
 * const [longitude, latitude] = getLatLngFromDIGIPIN("4T396F42L7")
 */
export function getLatLngFromDIGIPIN(pin: string): Coordinates2D {
	/**
	 * Result position in GeoJSON coordinate order.
	 */
	const position: Coordinates2D = [0, 0]

	getLatLngFromDIGIPINInto(pin, position)

	return position
}

/**
 * Decode a trusted DIGIPIN without validating its format.
 *
 * Returns a GeoJSON-compatible position.
 *
 * @param pin - Previously validated 10-character DIGIPIN without hyphens.
 * @returns Cell center as [longitude, latitude].
 *
 * @remarks Invalid inputs produce unspecified results without throwing.
 * A character outside ASCII decodes as `F`, and an invalid ASCII character corrupts the latitude bits.
 */
export function getLatLngFromDIGIPINUnsafe(pin: string): Coordinates2D {
	/**
	 * Result position in GeoJSON coordinate order.
	 */
	const position: Coordinates2D = [0, 0]

	getLatLngFromDIGIPINIntoUnsafe(pin, position)

	return position
}

/**
 * Decode a DIGIPIN directly into an existing coordinate buffer.
 *
 * Avoids allocating intermediate coordinate tuples.
 *
 * The destination receives longitude followed by latitude.
 * Supports both ordinary JavaScript arrays and Float64Array buffers.
 *
 * @param pin - DIGIPIN to decode, as 10 characters or in the display form `39J-49L-L8T4`.
 * Letters may be lowercase.
 * @param output - Destination coordinate buffer.
 * @param offset - Starting element offset.
 * Defaults to zero.
 *
 * @throws {RangeError} If DIGIPIN has an invalid length or character.
 *
 * @example
 * const pins = ["4T396F42L7", "4T396F42L7"]
 * const output = new Float64Array(pins.length * 2)
 *
 * for (let i = 0; i < pins.length; i++) {
 *   getLatLngFromDIGIPINInto(pins[i], output, i * 2)
 * }
 */
export function getLatLngFromDIGIPINInto(pin: string, output: number[] | Float64Array, offset = 0): void {
	/**
	 * Whether the input is in the display form with hyphens after the third and sixth characters.
	 */
	const hyphenated =
		pin.length === HYPHENATED_LENGTH &&
		pin.charCodeAt(FIRST_HYPHEN) === HYPHEN &&
		pin.charCodeAt(SECOND_HYPHEN) === HYPHEN

	if (!hyphenated && pin.length !== PRECISION) {
		throw new RangeError("Invalid DIGIPIN length")
	}

	/**
	 * Accumulated 20-bit latitude cell index.
	 */
	let lat = 0

	/**
	 * Accumulated 20-bit longitude cell index.
	 */
	let lon = 0

	/**
	 * String position of the next DIGIPIN character.
	 */
	let position = 0

	for (let i = 0; i < PRECISION; i++) {
		if (hyphenated && (position === FIRST_HYPHEN || position === SECOND_HYPHEN)) {
			position++
		}

		/**
		 * ASCII character code, normalized to uppercase.
		 */
		let code = pin.charCodeAt(position++)

		if (code >= LOWERCASE_A && code <= LOWERCASE_Z) {
			code -= CASE_OFFSET
		}

		if (code >= DECODE.length) {
			throw new RangeError("Invalid DIGIPIN character")
		}

		/**
		 * Flattened DIGIPIN grid position.
		 */
		const index = DECODE[code]

		if (index === INVALID || index === undefined) {
			throw new RangeError("Invalid DIGIPIN character")
		}

		lat = (lat << 2) | (3 - (index >>> 2))
		lon = (lon << 2) | (index & 3)
	}

	output[offset] = MIN_LON + (lon + 0.5) * CELL_SIZE
	output[offset + 1] = MIN_LAT + (lat + 0.5) * CELL_SIZE
}

/**
 * Decode a trusted DIGIPIN directly into an existing buffer.
 *
 * Skips length and character validation.
 * Intended for high-throughput batch processing.
 *
 * @param pin - Previously validated 10-character DIGIPIN.
 * @param output - Destination coordinate buffer.
 * @param offset - Starting element offset.
 * Defaults to zero.
 *
 * @remarks Invalid inputs produce unspecified results.
 *
 * The destination buffer must contain sufficient capacity for two coordinates
 * beginning at the specified offset.
 *
 * @example
 * const output = new Float64Array(2)
 *
 * getLatLngFromDIGIPINIntoUnsafe("4T396F42L7", output)
 */
export function getLatLngFromDIGIPINIntoUnsafe(pin: string, output: number[] | Float64Array, offset = 0): void {
	/**
	 * Accumulated 20-bit latitude cell index.
	 */
	let lat = 0

	/**
	 * Accumulated 20-bit longitude cell index.
	 */
	let lon = 0

	for (let i = 0; i < PRECISION; i++) {
		/**
		 * ASCII character code, normalized to uppercase.
		 */
		let code = pin.charCodeAt(i)

		if (code >= LOWERCASE_A && code <= LOWERCASE_Z) {
			code -= CASE_OFFSET
		}

		/**
		 * Flattened DIGIPIN grid position.
		 */
		const index = DECODE[code]!

		lat = (lat << 2) | (3 - (index >>> 2))
		lon = (lon << 2) | (index & 3)
	}

	output[offset] = MIN_LON + (lon + 0.5) * CELL_SIZE
	output[offset + 1] = MIN_LAT + (lat + 0.5) * CELL_SIZE
}

// #endregion
