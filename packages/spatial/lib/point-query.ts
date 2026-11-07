/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The shapes a typed query takes when it is a point rather than an address, and the one parser for them.
 *
 *   A search field receives coordinates in a dozen spellings, a plus code, an H3 cell, a geohash or a
 *   Who's On First id beside ordinary addresses. {@link parsePointQuery} reads the whole text as one of those shapes or
 *   answers `null`, so a caller sends only an address to the classifier. It reads text and decodes no cell: decoding a cell
 *   to a coordinate belongs to the module that owns the format, and the H3 reader loads a WebAssembly binary
 *   that a text test must not pay for.
 */

import { isValidLatitude, isValidLongitude } from "#coordinate/bounds"
import { isFullPlusCode, isShortPlusCode } from "#open-location-code"

/**
 * The axis order a coordinate pair was read in.
 *
 * `lat_lon` is the order people write and the order inside a Google Maps link.
 * `lon_lat` is reported when the first number is out of latitude range, so it can only be a longitude.
 */
export type CoordinateOrder = "lat_lon" | "lon_lat"

export type PointQuery =
	| {
			kind: "coordinates"
			lat: number
			lon: number
			order: CoordinateOrder
	  }
	| {
			/**
			 * An Open Location Code, upper-cased.
			 *
			 * A short code (`VFQ6+92P`) decodes only beside a reference position.
			 * The caller supplies that position.
			 */
			kind: "plus_code"
			code: string
			full: boolean
	  }
	| {
			/**
			 * An H3 cell index in its hexadecimal form, lower-cased.
			 *
			 * Only the shape is checked here: the H3 library decides validity when it decodes the cell.
			 */
			kind: "h3"
			cell: string
	  }
	| {
			/**
			 * A geohash, lower-cased.
			 *
			 * It is accepted only behind a `geohash:` or `gh:` prefix, because a bare hash is also a word.
			 */
			kind: "geohash"
			hash: string
	  }
	| {
			/**
			 * A Who's On First id, from `wof:85633793`, `wof 85633793` or a Spelunker link.
			 */
			kind: "wof"
			id: number
	  }

/**
 * `wof:85633793`, `wof 85633793`, `whosonfirst:85633793`.
 */
const WOF_REFERENCE = /^(?:wof|whosonfirst)[\s:]+(\d{1,16})$/iu

/**
 * A Spelunker place page, with or without the trailing slash.
 */
const SPELUNKER_URL = /^https?:\/\/spelunker\.whosonfirst\.org\/id\/(\d{1,16})\/?$/iu

/**
 * The hexadecimal form of an H3 cell: mode 1 in the high nibble, then fourteen more digits.
 */
const H3_CELL = /^(?:h3:)?(8[0-9a-f]{14})$/iu

/**
 * A geohash behind its prefix, in the base-32 alphabet that omits `a`, `i`, `l` and `o`.
 */
const GEOHASH_REFERENCE = /^(?:geohash|gh):\s*([0-9b-hjkmnp-z]{1,12})$/iu

/**
 * A `geo:` URI, `geo:48.8584,2.2945` with an optional altitude and parameters.
 */
const GEO_URI = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,-?\d+(?:\.\d+)?)?(?:;.*)?$/iu

/**
 * Google Maps' path segment, `@48.8584,2.2945,17z`, with the zoom optional.
 */
const MAPS_SEGMENT = /^@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,[\d.]+z)?$/iu

/**
 * A labeled pair in either order: `lat 48.85 lon 2.29`, `lng=2.29, lat=48.85`.
 */
const LABELED_PAIR =
	/^(lat(?:itude)?|lon(?:gitude)?|lng)\s*[:=]?\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(lat(?:itude)?|lon(?:gitude)?|lng)\s*[:=]?\s*(-?\d+(?:\.\d+)?)$/iu

/**
 * One angle: a signed decimal, or degrees with optional minutes and seconds,
 * each with its mark, and an optional hemisphere letter after it.
 */
const ANGLE =
	/^([+-])?\s*(\d+(?:\.\d+)?)\s*(?:°|º|d\b)?\s*(?:(\d+(?:\.\d+)?)\s*(?:'|′|’|m\b)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:"|″|”|''|s\b)\s*)?([NSEW])?$/iu

/**
 * A pair of angles is split at the comma or semicolon, or after the first hemisphere letter,
 * or between two decimal numbers at the whitespace between them.
 */
const PAIR_AT_HEMISPHERE = /^(.+?[NSEW])\s+(.+)$/iu
const PAIR_AT_SPACE = /^(\S+)\s+(\S+)$/u

interface Angle {
	degrees: number
	hemisphere: "N" | "S" | "E" | "W" | null
}

function parseAngle(text: string): Angle | null {
	const match = ANGLE.exec(text.trim())

	if (!match) return null

	const [, sign, degrees, minutes = "0", seconds = "0", letter] = match
	const magnitude = Number(degrees) + Number(minutes) / 60 + Number(seconds) / 3600

	if (!Number.isFinite(magnitude)) return null

	const hemisphere = letter ? (letter.toUpperCase() as Angle["hemisphere"]) : null
	const negative = sign === "-" || hemisphere === "S" || hemisphere === "W"

	return { degrees: negative ? -magnitude : magnitude, hemisphere }
}

/**
 * A pair of angles as the point they name, or `null` when the pair is out of range in both orders.
 *
 * Hemisphere letters decide the axis.
 * Without them the first number is the latitude, as in a Google Maps link,
 * unless only the other order is in range.
 */
function pairToPoint(first: Angle, second: Angle): PointQuery | null {
	const latLetters = new Set(["N", "S"])
	const lonLetters = new Set(["E", "W"])

	if (first.hemisphere && second.hemisphere) {
		if (latLetters.has(first.hemisphere) && lonLetters.has(second.hemisphere)) {
			return coordinates(first.degrees, second.degrees, "lat_lon")
		}

		if (lonLetters.has(first.hemisphere) && latLetters.has(second.hemisphere)) {
			return coordinates(second.degrees, first.degrees, "lon_lat")
		}

		return null
	}

	if (first.hemisphere) {
		return latLetters.has(first.hemisphere)
			? coordinates(first.degrees, second.degrees, "lat_lon")
			: coordinates(second.degrees, first.degrees, "lon_lat")
	}

	if (second.hemisphere) {
		return lonLetters.has(second.hemisphere)
			? coordinates(first.degrees, second.degrees, "lat_lon")
			: coordinates(second.degrees, first.degrees, "lon_lat")
	}

	return coordinates(first.degrees, second.degrees, "lat_lon") ?? coordinates(second.degrees, first.degrees, "lon_lat")
}

function coordinates(lat: number, lon: number, order: CoordinateOrder): PointQuery | null {
	if (!isValidLatitude(lat) || !isValidLongitude(lon)) return null

	return { kind: "coordinates", lat, lon, order }
}

/**
 * Whether a bare pair of numbers reads as a coordinate rather than two counts.
 *
 * `12 34` reads as a house number beside a postcode and as a position, so a bare pair
 * needs a comma, a decimal point, a degree mark or a hemisphere letter.
 */
const COORDINATE_MARK = /[,;.°º'′"″NSEW]/iu

function parseCoordinatePair(text: string): PointQuery | null {
	if (!COORDINATE_MARK.test(text)) return null

	const halves =
		(/[,;]/u.test(text) ? text.split(/[,;]/u, 2) : null) ??
		PAIR_AT_HEMISPHERE.exec(text)?.slice(1, 3) ??
		PAIR_AT_SPACE.exec(text)?.slice(1, 3)

	if (!halves || halves.length !== 2) return null

	const first = parseAngle(halves[0]!)
	const second = parseAngle(halves[1]!)

	if (!first || !second) return null

	return pairToPoint(first, second)
}

/**
 * Reads a whole query as the point it names: a coordinate pair in decimal,
 * degrees-minutes-seconds, `geo:` or Google Maps form, a full or short plus code,
 * an H3 cell, a prefixed geohash, or a Who's On First id.
 *
 * Returns `null` for text that is none of these.
 * Every address is such a text.
 *
 * A coordinate outside the valid range in both axis orders is also `null`, never clamped.
 */
export function parsePointQuery(text: string): PointQuery | null {
	const trimmed = text.trim()

	if (!trimmed) return null

	const wof = WOF_REFERENCE.exec(trimmed) ?? SPELUNKER_URL.exec(trimmed)

	if (wof) {
		const id = Number(wof[1])

		return Number.isSafeInteger(id) && id > 0 ? { kind: "wof", id } : null
	}

	const h3 = H3_CELL.exec(trimmed)

	if (h3) return { kind: "h3", cell: h3[1]!.toLowerCase() }

	const geohash = GEOHASH_REFERENCE.exec(trimmed)

	if (geohash) return { kind: "geohash", hash: geohash[1]!.toLowerCase() }

	if (isFullPlusCode(trimmed)) return { kind: "plus_code", code: trimmed.toUpperCase(), full: true }

	if (isShortPlusCode(trimmed)) return { kind: "plus_code", code: trimmed.toUpperCase(), full: false }

	const uri = GEO_URI.exec(trimmed) ?? MAPS_SEGMENT.exec(trimmed)

	if (uri) return coordinates(Number(uri[1]), Number(uri[2]), "lat_lon")

	const labeled = LABELED_PAIR.exec(trimmed)

	if (labeled) {
		const [, firstLabel, firstValue, secondLabel, secondValue] = labeled
		const firstIsLat = /^lat/iu.test(firstLabel!)

		if (firstIsLat === /^lat/iu.test(secondLabel!)) return null

		return firstIsLat
			? coordinates(Number(firstValue), Number(secondValue), "lat_lon")
			: coordinates(Number(secondValue), Number(firstValue), "lon_lat")
	}

	return parseCoordinatePair(trimmed)
}

/**
 * A coordinate pair as text, latitude first, in the form {@link parsePointQuery} reads back.
 *
 * Six decimals place a point within about 11 cm.
 */
export function coordinatePairText(lat: number, lon: number, decimals = 6): string {
	return `${lat.toFixed(decimals)}, ${lon.toFixed(decimals)}`
}

/**
 * The label a point query is shown under, such as the tag column of a parse.
 */
export const POINT_QUERY_LABEL: Record<PointQuery["kind"], string> = {
	coordinates: "coordinates",
	plus_code: "plus code",
	h3: "H3 cell",
	geohash: "geohash",
	wof: "Who's On First id",
}

/**
 * The same shapes as a noun phrase with its article, for a sentence: "this is a plus code".
 */
export const POINT_QUERY_PHRASE: Record<PointQuery["kind"], string> = {
	coordinates: "a coordinate pair",
	plus_code: "a plus code",
	h3: "an H3 cell",
	geohash: "a geohash",
	wof: "a Who's On First id",
}
