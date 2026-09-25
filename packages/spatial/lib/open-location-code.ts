/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

const OLC_ALPHABET = "23456789CFGHJMPQRVWX"

const OLC_DIGIT_VALUE = new Map<string, number>([...OLC_ALPHABET].map((c, i) => [c, i]))

const PAIR_RESOLUTIONS = [20, 1, 1 / 20, 1 / 400, 1 / 8000] as const

const GRID_COLUMNS = 4
const GRID_ROWS = 5

/**
 * Describes a decoded plus-code cell by its center and its span in degrees, from
 * which callers derive an uncertainty radius.
 */
export interface DecodedPlusCode {
	lat: number
	lon: number
	latSpanDeg: number
	lonSpanDeg: number
}

/**
 * Returns true for a full plus code of exactly 8 digits, `+`, and 2 or 3 digits.
 *
 * It rejects the padded and longer forms the spec allows, since addresses carry only the 10–11 digit form.
 */
export function isFullPlusCode(token: string): boolean {
	return /^[23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2,3}$/i.test(token)
}

/**
 * Returns true for a short plus code with 2, 4 or 6 digits before the `+`,
 * such as the `VFQ6+92P` form Google prints on place cards.
 */
export function isShortPlusCode(token: string): boolean {
	return /^[23456789CFGHJMPQRVWX]{2,6}\+[23456789CFGHJMPQRVWX]{2,3}$/i.test(token) && token.indexOf("+") % 2 === 0
}

/**
 * Decodes a full plus code to its cell, returning null for anything {@link isFullPlusCode} rejects.
 */
export function decodePlusCode(code: string): DecodedPlusCode | null {
	if (!isFullPlusCode(code)) return null
	const digits = code.toUpperCase().replace("+", "")

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

function encodePairDigits(lat: number, lon: number, length: number): string {
	let latVal = Math.min(Math.max(lat + 90, 0), 180 - 1e-12)
	let lonVal = lon + 180

	lonVal -= Math.floor(lonVal / 360) * 360

	let out = ""

	for (let i = 0; i < length / 2; i++) {
		const resolution = PAIR_RESOLUTIONS[i]!
		const latDigit = Math.min(Math.floor(latVal / resolution), 19)
		const lonDigit = Math.min(Math.floor(lonVal / resolution), 19)

		out += OLC_ALPHABET[latDigit]! + OLC_ALPHABET[lonDigit]!
		latVal -= latDigit * resolution
		lonVal -= lonDigit * resolution
	}

	return out
}

/**
 * Recovers a short plus code to the matching cell nearest a reference coordinate,
 * following the spec's `recoverNearest`.
 * It returns null for an invalid short code.
 */
export function recoverNearestPlusCode(shortCode: string, refLat: number, refLon: number): DecodedPlusCode | null {
	if (!isShortPlusCode(shortCode)) return null
	const upper = shortCode.toUpperCase()
	const missing = 8 - upper.indexOf("+")
	const prefix = encodePairDigits(refLat, refLon, missing)
	const candidate = decodePlusCode(prefix + upper)

	if (!candidate) return null

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
