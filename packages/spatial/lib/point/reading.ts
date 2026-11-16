// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file What a typed query resolves to when it is a point rather than an address, read from recognitions.
 *
 *   A search field receives coordinates in a dozen spellings, a plus code, an H3 cell, a geohash or a
 *   Who's On First id beside ordinary addresses. {@link recognizePointQuery} runs one recognizer over the `coordinates`,
 *   `spatial` and `identifiers` families of `@mailwoman/recognize` and answers from the recognition that spans the text.
 *   It decodes no cell: decoding a code to a coordinate belongs to the module that owns the format,
 *   and the H3 reader loads a WebAssembly binary that a text test shouldn't pay for.
 *
 *   # What makes a recognition a reading
 *
 *   A recognition is trusted when the engine's validator accepted it and its span is the whole text.
 *   An embedded span or a rejected recognition never becomes a reading: `Apt 4, 12 Main St` holds the valid pair `4, 12`.
 *
 *   The grammars admit no white space around a value, so **the caller trims** the text before it is read.
 *   The earth app trims where it takes the typed input.
 *
 *   # One handler for every kind
 *
 *   `handlers` has an entry for each kind of the three families, and the object is checked against
 *   `HandlerMap<typeof families>`. A kind added to any family fails the TypeScript build until it has a handler.
 *   A handler returns a point reading, or a {@link NotAPointQuery} with the recognized kind and the reason it isn't a point.
 */

import {
	createRecognizer,
	type HandlerMap,
	type KindsOf,
	type Recognition,
	type RecognitionsOf,
} from "@mailwoman/recognize"
import { coordinates } from "@mailwoman/recognize/coordinates"
import { isDeterministicSpatial } from "@mailwoman/recognize/deterministic/spatial"
import { identifiers } from "@mailwoman/recognize/identifiers"
import { spatial } from "@mailwoman/recognize/spatial"
import type { AxisOrder, Validated } from "@mailwoman/recognize/types"

/**
 * The families a point query is read from, composed once.
 */
const families = [coordinates, spatial, identifiers] as const

/**
 * Every kind of recognition a point query reads, one per shape of the three families.
 */
export type PointQueryKind = KindsOf<typeof families>

const recognizer = createRecognizer(families)

/**
 * A point reading is the point a text resolves to.
 *
 * `recognized` is the generated kind of the recognition the reading came from.
 */
export type PointReading = {
	readonly recognized: PointQueryKind
} & (
	| {
			/**
			 * A coordinate pair in decimal, degrees-minutes-seconds, labeled, `geo:`
			 * or Google Maps form, latitude and longitude as the validator branded them.
			 *
			 * `lon_lat` is reported when the first number is out of latitude range,
			 * so it can only be a longitude.
			 */
			readonly kind: "coordinates"
			readonly latitude: Validated.Latitude
			readonly longitude: Validated.Longitude
			readonly order: AxisOrder
	  }
	| {
			/**
			 * A GeoJSON `Point`.
			 * Its position is already latitude first in the payload.
			 */
			readonly kind: "geojson_point"
			readonly latitude: Validated.Latitude
			readonly longitude: Validated.Longitude
	  }
	| {
			/**
			 * A full Open Location Code, upper-cased.
			 * It decodes to a cell with no further input.
			 */
			readonly kind: "plus_code"
			readonly full: true
			readonly code: Validated.FullPlusCode
	  }
	| {
			/**
			 * A short Open Location Code, upper-cased.
			 * It decodes only beside a reference position.
			 */
			readonly kind: "plus_code"
			readonly full: false
			readonly code: Validated.ShortPlusCode
	  }
	| {
			/**
			 * A DIGIPIN, ten upper-case characters without hyphens.
			 */
			readonly kind: "digipin"
			readonly code: Validated.Digipin
	  }
	| {
			/**
			 * An H3 cell index in its hexadecimal form, lower-cased.
			 *
			 * The validator checks the shape, and the H3 library decides validity when it decodes the cell.
			 */
			readonly kind: "h3"
			readonly cell: string
	  }
	| {
			/**
			 * A geohash behind its `geohash:` or `gh:` prefix, lower-cased.
			 */
			readonly kind: "geohash"
			readonly hash: string
	  }
	| {
			/**
			 * A Who's On First id, from `wof:85633793`, `wof 85633793` or a Spelunker link.
			 */
			readonly kind: "wof"
			readonly id: Validated.Integer
	  }
)

/**
 * Lists why a recognized text isn't a point query.
 *
 * - `names_no_position`: the text is an identifier or a document with no single position,
 *   such as a Census GEOID, a GNIS feature id or a GeoJSON `LineString`.
 * - `ambiguous_without_prefix`: the text is a valid code whose spelling is also a phone number
 *   or a count, so no prefix or separator makes it a position.
 * - `digit_group`: the text is a well-formed code made only of digits in a grouped form.
 *   A phone number is written the same way.
 */
export type NotAPointReason = "names_no_position" | "ambiguous_without_prefix" | "digit_group"

/**
 * The text is a recognized shape and not a point query: a caller sends it to the address classifier.
 */
export interface NotAPointQuery {
	readonly kind: "not_a_point"
	readonly recognized: PointQueryKind
	readonly reason: NotAPointReason
}

/**
 * A text that's a whole recognition resolves to a point or to a shape that isn't a point.
 */
export type PointQueryReading = PointReading | NotAPointQuery

/**
 * The payload of a recognition the reader has already checked is validated.
 *
 * A recognition without one is a defect in the reader, so it throws rather than answering with an absence.
 */
function payloadOf<Payload>(recognition: {
	readonly kind: string
	readonly validation:
		| { readonly status: "validated"; readonly payload: Payload }
		| { readonly status: "rejected" | "unvalidated" }
}): Payload {
	const { validation } = recognition

	if (validation.status !== "validated") {
		throw new RangeError(`${recognition.kind} reached its point handler without a validated payload`)
	}

	return validation.payload
}

interface PairPayload {
	readonly latitude: Validated.Latitude
	readonly longitude: Validated.Longitude
	readonly order: AxisOrder
}

function coordinatePair(recognition: Recognition<PointQueryKind, PairPayload, string>): PointReading {
	const { latitude, longitude, order } = payloadOf(recognition)

	return { kind: "coordinates", recognized: recognition.kind, latitude, longitude, order }
}

function noPosition(recognition: { readonly kind: PointQueryKind }): NotAPointQuery {
	return { kind: "not_a_point", recognized: recognition.kind, reason: "names_no_position" }
}

function wofID(recognition: Recognition<PointQueryKind, { readonly id: Validated.Integer }, string>): PointReading {
	return { kind: "wof", recognized: recognition.kind, id: payloadOf(recognition).id }
}

function h3Cell(recognition: Recognition<PointQueryKind, { readonly cell: string }, string>): PointReading {
	return { kind: "h3", recognized: recognition.kind, cell: payloadOf(recognition).cell.toLowerCase() }
}

/**
 * One handler per kind.
 *
 * A new kind in any composed family fails this object's `satisfies` clause.
 *
 * The second clause fixes each handler's return type.
 * `HandlerMap` leaves it open.
 */
const handlers = {
	"coordinate.decimal_pair": coordinatePair,
	"coordinate.decimal_pair_spaced": coordinatePair,
	"coordinate.dms_pair": coordinatePair,
	"coordinate.dms_pair_spaced": coordinatePair,
	"coordinate.labeled_pair": coordinatePair,
	"coordinate.maps_segment": coordinatePair,
	// RFC 5870 fixes the order as latitude, longitude, altitude, and the payload has no order of its own.
	"coordinate.geo_uri": (recognition): PointReading => {
		const { latitude, longitude } = payloadOf(recognition)

		return { kind: "coordinates", recognized: recognition.kind, latitude, longitude, order: "lat_lon" }
	},

	"plus_code.token": (recognition): PointReading => {
		const { full_code, short_code } = payloadOf(recognition)

		if (full_code != null) return { kind: "plus_code", recognized: recognition.kind, full: true, code: full_code }

		if (short_code != null) return { kind: "plus_code", recognized: recognition.kind, full: false, code: short_code }

		// The validator fills exactly one of the two fields, so a validated payload with neither is a defect in the engine.
		throw new RangeError(`${recognition.kind} validated with neither a full code nor a short code`)
	},
	// The validator accepts the all-digit form.
	// A phone number is written the same way.
	// The trust rule decides.
	"digipin.display": (recognition): PointQueryReading =>
		isDeterministicSpatial(recognition, recognition.text)
			? { kind: "digipin", recognized: recognition.kind, code: payloadOf(recognition).code }
			: { kind: "not_a_point", recognized: recognition.kind, reason: "digit_group" },
	// Ten characters from `2` to `9` and `C F J K L M P T` are also a phone number, a count or a postcode.
	"digipin.compact": (recognition): NotAPointQuery => ({
		kind: "not_a_point",
		recognized: recognition.kind,
		reason: "ambiguous_without_prefix",
	}),
	// A GeoJSON `Point` is the point.
	// Every other GeoJSON type is a document with no single position.
	"geojson.object": (recognition): PointQueryReading => {
		const { type, latitude, longitude } = payloadOf(recognition)

		if (type === "Point" && latitude != null && longitude != null) {
			return { kind: "geojson_point", recognized: recognition.kind, latitude, longitude }
		}

		return noPosition(recognition)
	},

	// A Census GEOID is a run of digits, and the state code is the only part the validator can check.
	"census.geoid_block": noPosition,
	"census.geoid_block_group": noPosition,
	"census.geoid_county": noPosition,
	"census.geoid_state": noPosition,
	"census.geoid_tract": noPosition,
	"gnis.reference": noPosition,
	"gnis.summary_url": noPosition,

	"geohash.prefixed": (recognition): PointReading => ({
		kind: "geohash",
		recognized: recognition.kind,
		hash: payloadOf(recognition).hash.toLowerCase(),
	}),
	// A bare H3 cell is read as a point here: the map's copy menu writes one,
	// and a search field that reads back what the map copied is the contract.
	// `isDeterministicIdentifier` withholds a bare cell from an address parse,
	// because 15 hexadecimal digits are also a count.
	"h3.cell": h3Cell,
	"h3.prefixed_cell": h3Cell,
	"wof.reference": wofID,
	"wof.spelunker_url": wofID,
} satisfies HandlerMap<typeof families> & Record<PointQueryKind, (recognition: never) => PointQueryReading>

/**
 * Reads a trimmed text as a point, or as a recognized shape that isn't a point query.
 *
 * Returns `null` when no recognition of the three families is validated and covers the whole text.
 * Every address is such a text.
 *
 * A coordinate out of range in both axis orders is a rejected recognition,
 * so it reads as `null`, never clamped.
 *
 * @param text The text the caller already trimmed, because the grammars admit no outer white space.
 */
export function recognizePointQuery(text: string): PointQueryReading | null {
	let notAPoint: NotAPointQuery | null = null

	for (const recognition of recognizer.recognize(text).recognitions) {
		if (recognition.validation.status !== "validated" || recognition.start !== 0 || recognition.end !== text.length) {
			continue
		}

		const handler = handlers[recognition.kind] as (recognition: RecognitionsOf<typeof families>) => PointQueryReading
		const reading = handler(recognition)

		// Two shapes may cover one text, such as a Census GEOID and an H3 cell.
		// The point wins.
		if (reading.kind !== "not_a_point") return reading

		notAPoint ??= reading
	}

	return notAPoint
}

/**
 * Reads a trimmed text as a point, or `null` when it is an address or a recognized shape with no position.
 */
export function pointFromText(text: string): PointReading | null {
	const reading = recognizePointQuery(text)

	return reading && reading.kind !== "not_a_point" ? reading : null
}
