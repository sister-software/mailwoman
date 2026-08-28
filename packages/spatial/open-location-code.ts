/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Open Location Code (plus code) decode + nearest-recovery — the coordinate system Google Maps
 *   prints on every place card, which makes it a first-class user register in countries with sparse
 *   street addressing (the Nicaraguan board rows arrived exactly this way). Pure arithmetic over the
 *   published spec (https://github.com/google/open-location-code/blob/main/docs/specification.md);
 *   no dependency, no I/O.
 *
 *   A FULL code (8 digits, a `+`, then 2–3 more) decodes directly. A SHORT code (2–6 leading digits
 *   removed, e.g. `VFQ6+92P`) is only meaningful near a reference point — the removed prefix is
 *   recovered from the reference, then the candidate cell is shifted by whole prefix-resolutions if
 *   a neighboring cell sits closer (the spec's `recoverNearest`). The reference in an address is the
 *   RESOLVED LOCALITY, which is why the geocode wiring recovers after the admin walk.
 */

/**
 * The 20-character OLC digit set. Deliberately excludes letters that read as words or digits (no A/E/I/L/N/O/S/T…), so
 * a matched token is very unlikely to be ordinary text.
 */
const OLC_ALPHABET = "23456789CFGHJMPQRVWX"

const OLC_DIGIT_VALUE = new Map<string, number>([...OLC_ALPHABET].map((c, i) => [c, i]))

/**
 * Degree width of each pair-position, most significant first: the pair at index i spans `20^(2-i)` degrees. Ten pair
 * digits (five lat/lon pairs) take a cell to 1/400° ≈ 275 m; grid digits refine further.
 */
const PAIR_RESOLUTIONS = [20, 1, 1 / 20, 1 / 400, 1 / 8000] as const

/**
 * Grid refinement past ten digits: each digit subdivides the cell into 4 columns × 5 rows.
 */
const GRID_COLUMNS = 4
const GRID_ROWS = 5

/**
 * A decoded plus-code cell: the center (the coordinate consumers want) plus the cell's span, from which callers price
 * the claim (`uncertaintyM` ≈ the half-diagonal).
 */
export interface DecodedPlusCode {
	lat: number
	lon: number
	latSpanDeg: number
	lonSpanDeg: number
}

/**
 * A syntactically-valid FULL plus code: exactly 8 digits, `+`, then 2 or 3 digits. (The spec allows padded and longer
 * forms; addresses carry the 10–11 digit register, which is all this reader accepts.)
 */
export function isFullPlusCode(token: string): boolean {
	return /^[23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2,3}$/i.test(token)
}

/**
 * A syntactically-valid SHORT plus code: 2, 4, or 6 leading digits removed — so 6, 4, or 2 digits before the `+`. The
 * 4-before-`+` form (`VFQ6+92P`) is the one Google prints on place cards.
 */
export function isShortPlusCode(token: string): boolean {
	return /^[23456789CFGHJMPQRVWX]{2,6}\+[23456789CFGHJMPQRVWX]{2,3}$/i.test(token) && token.indexOf("+") % 2 === 0
}

/**
 * Decode a FULL plus code to its cell. Returns null on anything `isFullPlusCode` rejects.
 */
export function decodePlusCode(code: string): DecodedPlusCode | null {
	if (!isFullPlusCode(code)) return null
	const digits = code.toUpperCase().replace("+", "")

	let latLo = -90
	let lonLo = -180
	let latSpan = 400
	let lonSpan = 400

	// The first ten digits arrive in (lat, lon) pairs.
	const pairCount = Math.min(digits.length, 10)

	for (let i = 0; i < pairCount; i += 2) {
		const resolution = PAIR_RESOLUTIONS[i / 2]!

		latLo += OLC_DIGIT_VALUE.get(digits[i]!)! * resolution
		lonLo += OLC_DIGIT_VALUE.get(digits[i + 1]!)! * resolution
		latSpan = resolution
		lonSpan = resolution
	}

	// Grid refinement: each further digit indexes a 4×5 (columns × rows) subdivision.
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
 * Encode the pair digits of a coordinate to `length` digits (length ≤ 10, even) — the prefix implementation
 * {@link recoverNearestPlusCode} needs; not a general encoder.
 */
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
 * Recover a SHORT plus code against a reference coordinate, per the spec's `recoverNearest`: prepend the reference's
 * prefix at the missing precision, then shift the candidate cell by whole prefix-resolutions when a neighboring cell
 * center sits closer to the reference. Returns the decoded nearest cell, or null for an invalid short code.
 */
export function recoverNearestPlusCode(shortCode: string, refLat: number, refLon: number): DecodedPlusCode | null {
	if (!isShortPlusCode(shortCode)) return null
	const upper = shortCode.toUpperCase()
	const missing = 8 - upper.indexOf("+")
	const prefix = encodePairDigits(refLat, refLon, missing)
	const candidate = decodePlusCode(prefix + upper)

	if (!candidate) return null

	// The prefix pins the cell modulo its own resolution; the nearest bearer of the short code may sit
	// one prefix-cell away (the reference near a cell edge). Shift by whole prefix-resolutions, never
	// past the poles.
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
