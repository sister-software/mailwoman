// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Open Location Code arithmetic.
 *
 *   A code is read by the `spatial` family of `@mailwoman/recognize`, which owns the alphabet, the separator
 *   and the digit counts. The decoders here take the validated, branded `Validated.FullPlusCode` and `Validated.ShortPlusCode` the family returns,
 *   so a caller cannot pass an unchecked string. A test or a tool that holds a string reads it through the recognizer.
 */

import type { Validated } from "@mailwoman/recognize/types"

import type { DegreeCell } from "#coordinate/cell"

const OLC_ALPHABET = "23456789CFGHJMPQRVWX"

/**
 * The digits before the separator of a full code.
 *
 * The validator reads eight as a full code and two, four or six as a short one.
 */
const FULL_PREFIX_LENGTH = 8

const OLC_DIGIT_VALUE = new Map<string, number>([...OLC_ALPHABET].map((c, i) => [c, i]))

const PAIR_RESOLUTIONS = [20, 1, 1 / 20, 1 / 400, 1 / 8000] as const

const GRID_COLUMNS = 4
const GRID_ROWS = 5

/**
 * A decoded plus-code cell by its center and its span in degrees, from
 * which callers derive an uncertainty radius.
 */
export type DecodedPlusCode = DegreeCell

/**
 * Decodes a full code to its cell.
 *
 * The validator guarantees the alphabet and the digit counts, and the brand guarantees
 * the eight digits before the separator, so no input to this function fails.
 * A short code has its own brand and decodes through {@link recoverNearestPlusCode}.
 */
export function decodePlusCode(code: Validated.FullPlusCode): DecodedPlusCode {
	return decodeDigits(code.replace("+", ""))
}

/**
 * Decodes the digits of a full code, 10 or 11 of them, without the separator.
 */
function decodeDigits(digits: string): DecodedPlusCode {
	let latLo = -90
	let lonLo = -180
	let latSpan = 400
	let lonSpan = 400

	const pairCount = Math.min(digits.length, 10)

	for (let i = 0; i < pairCount; i += 2) {
		const resolution = PAIR_RESOLUTIONS[i / 2]!

		latLo += OLC_DIGIT_VALUE.get(digits[i]!)! * resolution
		lonLo += OLC_DIGIT_VALUE.get(digits[i + 1]!)! * resolution
		latSpan = resolution
		lonSpan = resolution
	}

	for (let i = 10; i < digits.length; i++) {
		const value = OLC_DIGIT_VALUE.get(digits[i]!)!

		latSpan /= GRID_ROWS
		lonSpan /= GRID_COLUMNS
		latLo += Math.floor(value / GRID_COLUMNS) * latSpan
		lonLo += (value % GRID_COLUMNS) * lonSpan
	}

	return {
		lat: latLo + latSpan / 2,
		lon: lonLo + lonSpan / 2,
		latSpanDeg: latSpan,
		lonSpanDeg: lonSpan,
	}
}

/**
 * The pair digits of a code and the position's remainder inside the last pair's cell, in degrees.
 */
interface PairEncoding {
	digits: string
	latRemainder: number
	lonRemainder: number
}

function encodePairs(lat: number, lon: number, length: number): PairEncoding {
	let latVal = Math.min(Math.max(lat + 90, 0), 180 - 1e-12)
	let lonVal = lon + 180

	lonVal -= Math.floor(lonVal / 360) * 360

	let digits = ""

	for (let i = 0; i < length / 2; i++) {
		const resolution = PAIR_RESOLUTIONS[i]!
		const latDigit = Math.min(Math.floor(latVal / resolution), 19)
		const lonDigit = Math.min(Math.floor(lonVal / resolution), 19)

		digits += OLC_ALPHABET[latDigit]! + OLC_ALPHABET[lonDigit]!
		latVal -= latDigit * resolution
		lonVal -= lonDigit * resolution
	}

	return { digits, latRemainder: latVal, lonRemainder: lonVal }
}

function encodePairDigits(lat: number, lon: number, length: number): string {
	return encodePairs(lat, lon, length).digits
}

/**
 * The code lengths this encoder writes: the ten-digit code Google prints,
 * or the eleven-digit code with one grid refinement digit.
 */
export type PlusCodeLength = 10 | 11

/**
 * Encodes a coordinate as a full plus code of 10 or 11 digits, the forms an address holds.
 *
 * The eleventh digit refines the last pair's cell on the 4 × 5 grid the spec defines.
 * The digits come from the specification's alphabet and the separator follows the eighth,
 * so the code has the form the validator accepts and the decoders take.
 */
export function encodePlusCode(lat: number, lon: number, length: PlusCodeLength = 10): Validated.FullPlusCode {
	const { digits, latRemainder, lonRemainder } = encodePairs(lat, lon, 10)
	const code = `${digits.slice(0, FULL_PREFIX_LENGTH)}+${digits.slice(FULL_PREFIX_LENGTH)}`

	if (length === 10) return code as Validated.FullPlusCode

	const cell = PAIR_RESOLUTIONS[4]!
	const row = Math.min(Math.floor(latRemainder / (cell / GRID_ROWS)), GRID_ROWS - 1)
	const column = Math.min(Math.floor(lonRemainder / (cell / GRID_COLUMNS)), GRID_COLUMNS - 1)

	return (code + OLC_ALPHABET[row * GRID_COLUMNS + column]!) as Validated.FullPlusCode
}

/**
 * Recovers a short plus code to the matching cell nearest a reference coordinate,
 * following the spec's `recoverNearest`.
 *
 * The brand guarantees two, four or six digits before the separator, so every short code recovers to a cell.
 * The reference must be a finite coordinate.
 *
 * Every caller already holds one.
 * A full code has its own brand and decodes through {@link decodePlusCode}.
 */
export function recoverNearestPlusCode(
	shortCode: Validated.ShortPlusCode,
	refLat: number,
	refLon: number
): DecodedPlusCode {
	const missing = FULL_PREFIX_LENGTH - shortCode.indexOf("+")
	const prefix = encodePairDigits(refLat, refLon, missing)
	const candidate = decodeDigits(prefix + shortCode.replace("+", ""))

	const LAT_MIN = -90
	const LAT_MAX = 90
	const prefixResolution = PAIR_RESOLUTIONS[missing / 2 - 1]!
	const result = { ...candidate }

	if (refLat + prefixResolution / 2 < result.lat && result.lat - prefixResolution >= LAT_MIN) {
		result.lat -= prefixResolution
	} else if (refLat - prefixResolution / 2 > result.lat && result.lat + prefixResolution <= LAT_MAX) {
		result.lat += prefixResolution
	}

	if (refLon + prefixResolution / 2 < result.lon) {
		result.lon -= prefixResolution
	} else if (refLon - prefixResolution / 2 > result.lon) {
		result.lon += prefixResolution
	}

	return result
}
