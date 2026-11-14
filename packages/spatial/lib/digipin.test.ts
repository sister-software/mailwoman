// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { expect, test } from "vitest"

import {
	getDIGIPIN,
	getDIGIPINUnsafe,
	getLatLngFromDIGIPIN,
	getLatLngFromDIGIPINUnsafe,
	getLatLngFromDIGIPINInto,
	getLatLngFromDIGIPINIntoUnsafe,
} from "#digipin"

/**
 * Original India Post grid.
 *
 * Kept independent of the implementation under test.
 */
const GRID = [
	["F", "C", "9", "8"],
	["J", "3", "2", "7"],
	["K", "4", "5", "6"],
	["L", "M", "P", "T"],
] as const

/**
 * Reference encoder using recursive geographic subdivision.
 */
function referenceEncode(latitude: number, longitude: number): string {
	let minLat = 2.5
	let maxLat = 38.5
	let minLon = 63.5
	let maxLon = 99.5

	let pin = ""

	for (let i = 0; i < 10; i++) {
		const latStep = (maxLat - minLat) / 4
		const lonStep = (maxLon - minLon) / 4

		const row = Math.max(0, Math.min(3, 3 - Math.floor((latitude - minLat) / latStep)))

		const col = Math.max(0, Math.min(3, Math.floor((longitude - minLon) / lonStep)))

		pin += GRID[row]![col]!

		const nextMinLat = minLat + latStep * (3 - row)
		const nextMinLon = minLon + lonStep * col

		maxLat = minLat + latStep * (4 - row)
		minLat = nextMinLat

		minLon = nextMinLon
		maxLon = nextMinLon + lonStep
	}

	return pin
}

/**
 * Deterministic pseudorandom generator.
 *
 * Allows randomized tests to reproduce failures.
 */
function* random(seed = 0x12_34_56_78): Generator<number> {
	let state = seed >>> 0

	while (true) {
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5

		yield (state >>> 0) / 0x1_00_00_00_00
	}
}

// #region Encoding & Decoding

test("encodes coordinates into 10-character DIGIPINs", () => {
	const pin = getDIGIPIN(13.11179621, 80.20264269)

	expect(pin).toBe(referenceEncode(13.11179621, 80.20264269))
	expect(pin).toMatch(/^[23456789CJKLMPFT]{10}$/)
})

test.each([
	[2.5, 63.5],
	[2.5, 99.5],
	[38.5, 63.5],
	[38.5, 99.5],
	[20.5, 81.5],
	[13.11179621, 80.20264269],
	[28.6139, 77.209],
	[19.076, 72.8777],
	[12.9716, 77.5946],
	[22.5726, 88.3639],
])("matches reference encoder at (%f, %f)", (lat, lon) => {
	expect(getDIGIPIN(lat, lon)).toBe(referenceEncode(lat, lon))
})

test.each([
	[2.5, 63.5],
	[2.5, 99.5],
	[38.5, 63.5],
	[38.5, 99.5],
])("accepts inclusive geographic boundaries (%f, %f)", (lat, lon) => {
	expect(getDIGIPIN(lat, lon)).toHaveLength(10)
})

test.each([
	[2.499999, 80],
	[38.500001, 80],
	[20, 63.499999],
	[20, 99.500001],
	[Number.NaN, 80],
	[20, Number.NaN],
	[Infinity, 80],
	[-Infinity, 80],
	[20, Infinity],
	[20, -Infinity],
])("rejects invalid coordinates (%f, %f)", (lat, lon) => {
	expect(() => getDIGIPIN(lat, lon)).toThrow(RangeError)
})

test("produces different DIGIPINs for neighboring cells", () => {
	const latitude = 20
	const longitude = 80

	const cellSize = 36 / 2 ** 20

	const a = getDIGIPIN(latitude, longitude)
	const b = getDIGIPIN(latitude, longitude + cellSize * 2)

	expect(a).not.toBe(b)
})

test("decodes into GeoJSON longitude-latitude order", () => {
	const pin = getDIGIPIN(13.11179621, 80.20264269)

	const [longitude, latitude] = getLatLngFromDIGIPIN(pin)

	expect(longitude).toBeGreaterThan(63.5)
	expect(longitude).toBeLessThan(99.5)

	expect(latitude).toBeGreaterThan(2.5)
	expect(latitude).toBeLessThan(38.5)
})

test("decoding returns the center of the encoded cell", () => {
	const latitude = 13.11179621
	const longitude = 80.20264269

	const pin = getDIGIPIN(latitude, longitude)
	const [decodedLon, decodedLat] = getLatLngFromDIGIPIN(pin)

	const halfCell = 36 / 2 ** 21

	expect(Math.abs(decodedLat - latitude)).toBeLessThanOrEqual(halfCell + 1e-12)
	expect(Math.abs(decodedLon - longitude)).toBeLessThanOrEqual(halfCell + 1e-12)
})

test("encoding a decoded cell center preserves DIGIPIN", () => {
	const pin = getDIGIPIN(28.6139, 77.209)

	const [lon, lat] = getLatLngFromDIGIPIN(pin)

	expect(getDIGIPIN(lat, lon)).toBe(pin)
})

test("supports case-insensitive decoding", () => {
	const pin = getDIGIPIN(28.6139, 77.209)

	expect(getLatLngFromDIGIPIN(pin.toLowerCase())).toEqual(getLatLngFromDIGIPIN(pin))
})

test.each([
	"",
	"F",
	"FFFFFFFFF",
	"FFFFFFFFFFF",
	"FFFFFFFFF0",
	"FFFFFFFFFA",
	"FFFFFFFFFI",
	"FFFFFFFFFO",
	"FFFFFFFFFU",
	"FFFFFFFFF-",
	"FFFFFFFFF ",
	" FFFFFFFFF",
	"FFFFFFFFF\n",
	"FFFFFFFFF😀",
	"FFFFFFFFFé",
	"FFFFFFFFFĀ",
	"FFFF-FFF-FFF",
	"FF-FFFF-FFFF",
	"FFF-FFF-FFF",
	"FFF-FFF-FFFFF",
	"FFF FFF FFFF",
	"FFF-FFF-FFF-",
	"FFFFFF-FFFF",
])("rejects malformed DIGIPIN %j", (pin) => {
	expect(() => getLatLngFromDIGIPIN(pin)).toThrow(RangeError)
})

test("decodes the hyphenated display form", () => {
	const pin = getDIGIPIN(28.6139, 77.209)
	const hyphenated = `${pin.slice(0, 3)}-${pin.slice(3, 6)}-${pin.slice(6)}`

	expect(getLatLngFromDIGIPIN(hyphenated)).toEqual(getLatLngFromDIGIPIN(pin))
	expect(getLatLngFromDIGIPIN(hyphenated.toLowerCase())).toEqual(getLatLngFromDIGIPIN(pin))

	const output = new Float64Array(2)

	getLatLngFromDIGIPINInto(hyphenated, output)

	expect(Array.from(output)).toEqual(getLatLngFromDIGIPIN(pin))
})

test("decodes every approved character", () => {
	const alphabet = "23456789CJKLMPFT"

	for (const char of alphabet) {
		const pin = char.repeat(10)

		expect(() => getLatLngFromDIGIPIN(pin)).not.toThrow()

		const [lon, lat] = getLatLngFromDIGIPIN(pin)

		expect(Number.isFinite(lon)).toBe(true)
		expect(Number.isFinite(lat)).toBe(true)
	}
})

test("unsafe encoder matches validated encoder", () => {
	const latitude = 28.6139
	const longitude = 77.209

	expect(getDIGIPINUnsafe(latitude, longitude)).toBe(getDIGIPIN(latitude, longitude))
})

test("unsafe decoder matches validated decoder", () => {
	const pin = getDIGIPIN(28.6139, 77.209)

	expect(getLatLngFromDIGIPINUnsafe(pin)).toEqual(getLatLngFromDIGIPIN(pin))
})

test("decodes into a Float64Array", () => {
	const pin = getDIGIPIN(28.6139, 77.209)

	const output = new Float64Array(2)

	getLatLngFromDIGIPINInto(pin, output)

	expect(Array.from(output)).toEqual(getLatLngFromDIGIPIN(pin))
})

test("supports offsets into preallocated buffers", () => {
	const pins = [getDIGIPIN(28.6139, 77.209), getDIGIPIN(19.076, 72.8777), getDIGIPIN(12.9716, 77.5946)]

	const output = new Float64Array(pins.length * 2)

	for (let i = 0; i < pins.length; i++) {
		getLatLngFromDIGIPINInto(pins[i]!, output, i * 2)
	}

	for (let i = 0; i < pins.length; i++) {
		expect(Array.from(output.slice(i * 2, i * 2 + 2))).toEqual(getLatLngFromDIGIPIN(pins[i]!))
	}
})

test("unsafe buffer decoder matches validated decoder", () => {
	const pin = getDIGIPIN(28.6139, 77.209)

	const safe = new Float64Array(2)
	const unsafe = new Float64Array(2)

	getLatLngFromDIGIPINInto(pin, safe)
	getLatLngFromDIGIPINIntoUnsafe(pin, unsafe)

	expect(unsafe).toEqual(safe)
})

test("supports ordinary JavaScript arrays as output buffers", () => {
	const pin = getDIGIPIN(28.6139, 77.209)

	const output = [0, 0]

	getLatLngFromDIGIPINInto(pin, output)

	expect(output).toEqual(getLatLngFromDIGIPIN(pin))
})

test("preserves unrelated buffer elements", () => {
	const pin = getDIGIPIN(28.6139, 77.209)

	const output = new Float64Array([100, 200, 300, 400, 500])

	getLatLngFromDIGIPINInto(pin, output, 2)

	expect(output[0]).toBe(100)
	expect(output[1]).toBe(200)
	expect(output[4]).toBe(500)

	expect([output[2], output[3]]).toEqual(getLatLngFromDIGIPIN(pin))
})

test("randomized round trips preserve cell identity", () => {
	const rng = random()

	for (let i = 0; i < 10_000; i++) {
		const latitude = 2.5 + rng.next().value! * 36
		const longitude = 63.5 + rng.next().value! * 36

		const pin = getDIGIPIN(latitude, longitude)
		const [lon, lat] = getLatLngFromDIGIPIN(pin)

		expect(getDIGIPIN(lat, lon)).toBe(pin)
	}
})

// #region Randomized Tests

test("randomized encoding matches reference implementation", () => {
	const rng = random(0xde_ad_be_ef)

	for (let i = 0; i < 10_000; i++) {
		const latitude = 2.5 + rng.next().value! * 36
		const longitude = 63.5 + rng.next().value! * 36

		expect(getDIGIPIN(latitude, longitude)).toBe(referenceEncode(latitude, longitude))
	}
})

// #region Integer quantization

/**
 * Return the smallest representable float greater than value.
 */
function nextUp(value: number): number {
	if (Number.isNaN(value) || value === Infinity) return value

	if (value === 0) return Number.MIN_VALUE

	const buffer = new ArrayBuffer(8)
	const view = new DataView(buffer)

	view.setFloat64(0, value)

	const bits = view.getBigUint64(0)
	view.setBigUint64(0, value > 0 ? bits + 1n : bits - 1n)

	return view.getFloat64(0)
}

/**
 * Return the largest representable float smaller than value.
 */
function nextDown(value: number): number {
	return -nextUp(-value)
}

test("matches reference encoder at floating-point subdivision boundaries", () => {
	const latitude = 20.5
	const longitude = 81.5

	for (let level = 1; level <= 10; level++) {
		const divisions = 4 ** level
		const cellSize = 36 / divisions

		// Exercise boundaries at several locations along each axis.
		const indices = [
			0,
			1,
			2,
			3,
			Math.floor(divisions / 4),
			Math.floor(divisions / 2),
			Math.floor((divisions * 3) / 4),
			divisions - 1,
			divisions,
		]

		for (const index of indices) {
			const latBoundary = 2.5 + index * cellSize
			const lonBoundary = 63.5 + index * cellSize

			// Test exact boundary and adjacent representable floats.
			const latitudes = [nextDown(latBoundary), latBoundary, nextUp(latBoundary)]

			const longitudes = [nextDown(lonBoundary), lonBoundary, nextUp(lonBoundary)]

			for (const lat of latitudes) {
				if (lat < 2.5 || lat > 38.5) continue

				expect(getDIGIPIN(lat, longitude)).toBe(referenceEncode(lat, longitude))
			}

			for (const lon of longitudes) {
				if (lon < 63.5 || lon > 99.5) continue

				expect(getDIGIPIN(latitude, lon)).toBe(referenceEncode(latitude, lon))
			}
		}
	}
})

// #endregion
