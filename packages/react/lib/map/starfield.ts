// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A procedural star sky for the globe projection, and the camera math that places it on screen.
 *
 *   Stars are unit vectors fixed to the Earth's frame, so the sky turns with
 *   the globe as the camera orbits it.
 *   Their magnitudes follow the naked-eye count law, where each fainter magnitude holds about
 *   3.2 times the star count, and a share of them crowd a band along the real galactic plane.
 *
 *   The catalog is seeded, so every render of the same options draws the same sky.
 *
 *   This module touches no DOM or WebGL at import, so node tests can load it.
 */

import { mulberry32 } from "@mailwoman/core/random"

/**
 * The options that shape a generated sky.
 */
export interface StarfieldOptions {
	/**
	 * The number of stars to generate.
	 *
	 * MapLibre's vertical field of view is about 37°, so roughly 6% of the sphere is on screen at once.
	 *
	 * @defaultValue 20000
	 */
	count?: number
	/**
	 * Seed for the generator.
	 * The same seed draws the same sky.
	 *
	 * @defaultValue 1
	 */
	seed?: number
	/**
	 * Share of stars drawn into the Milky Way band, from 0 to 1.
	 *
	 * @defaultValue 0.35
	 */
	bandShare?: number
	/**
	 * Fill painted behind the stars, or `null` to leave the canvas transparent.
	 *
	 * @defaultValue `"#02030a"`
	 */
	background?: string | null
}

/**
 * A generated sky.
 *
 * Each star occupies one stride of `STAR_STRIDE` floats in `data`: x, y, z,
 * radius in CSS pixels, alpha, then red, green and blue from 0 to 255.
 */
export interface StarCatalog {
	count: number
	data: Float32Array
}

/**
 * The number of floats each star occupies in `StarCatalog.data`.
 */
export const STAR_STRIDE = 8

/**
 * The camera state the sky projection reads, in MapLibre's units.
 */
export interface SkyCamera {
	/**
	 * Map center longitude in degrees.
	 */
	lng: number
	/**
	 * Map center latitude in degrees.
	 */
	lat: number
	/**
	 * Degrees clockwise from north.
	 */
	bearing: number
	/**
	 * Degrees of tilt away from looking straight down.
	 */
	pitch: number
	/**
	 * Vertical field of view in degrees.
	 */
	fov: number
}

type Vec3 = readonly [number, number, number]

const DEG = Math.PI / 180

// The brightest and faintest magnitudes drawn.
// Sirius sits near -1.5, and 6.5 is the naked-eye limit under a dark sky.
const MAG_BRIGHT = -1.5
const MAG_FAINT = 6.5
// N(<m) grows as 10^(K·m).
// K = 0.5 roughly matches the bright-star catalog counts between magnitudes 0 and 6.5.
const MAG_SLOPE = 0.5

// The galactic north pole and the galactic center in equatorial coordinates (J2000),
// treating right ascension as a longitude on the Earth-fixed sphere.
const GALACTIC_POLE = unitVector(192.859, 27.128)
const GALACTIC_CENTER = unitVector(266.405, -28.936)
const GALACTIC_THIRD = cross(GALACTIC_POLE, GALACTIC_CENTER)
// Below this radius in CSS pixels a star is drawn as one whole pixel rather than a disc.
const POINT_RADIUS = 0.9

// Standard deviation, in degrees of galactic latitude, of a band star's distance from the plane.
const BAND_WIDTH = 9

// Star colors by B−V color index, from hot blue stars to cool red ones.
const COLOR_STOPS: readonly (readonly [number, number, number, number])[] = [
	[-0.3, 155, 176, 255],
	[0, 202, 215, 255],
	[0.3, 248, 247, 255],
	[0.6, 255, 244, 234],
	[0.9, 255, 222, 180],
	[1.4, 255, 196, 130],
	[2, 255, 170, 100],
]

/**
 * Converts a longitude and latitude in degrees to a unit vector in the Earth-fixed frame.
 */
export function unitVector(lng: number, lat: number): Vec3 {
	const cosLat = Math.cos(lat * DEG)

	return [cosLat * Math.cos(lng * DEG), cosLat * Math.sin(lng * DEG), Math.sin(lat * DEG)]
}

function cross(a: Vec3, b: Vec3): Vec3 {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function gaussian(random: () => number): number {
	const u = Math.max(random(), Number.EPSILON)

	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random())
}

/**
 * Draws a magnitude from the count law by inverting its cumulative distribution over the drawn range.
 */
function sampleMagnitude(u: number): number {
	const span = 10 ** (MAG_SLOPE * (MAG_FAINT - MAG_BRIGHT)) - 1

	return MAG_BRIGHT + Math.log10(1 + u * span) / MAG_SLOPE
}

/**
 * Draws a B−V index from a mixture weighted toward the sun-like and orange
 * stars that dominate a naked-eye sky.
 */
function sampleColorIndex(random: () => number): number {
	const value = 0.55 + 0.45 * gaussian(random)

	return Math.min(2, Math.max(-0.3, value))
}

/**
 * Interpolates the RGB color of a star from its B−V index.
 */
export function starColor(colorIndex: number): [number, number, number] {
	const last = COLOR_STOPS.at(-1)!

	if (colorIndex >= last[0]) return [last[1], last[2], last[3]]

	for (let i = 1; i < COLOR_STOPS.length; i++) {
		const upper = COLOR_STOPS[i]!

		if (colorIndex > upper[0]) continue

		const lower = COLOR_STOPS[i - 1]!
		const t = Math.max(0, (colorIndex - lower[0]) / (upper[0] - lower[0]))

		return [
			lower[1] + (upper[1] - lower[1]) * t,
			lower[2] + (upper[2] - lower[2]) * t,
			lower[3] + (upper[3] - lower[3]) * t,
		]
	}

	const first = COLOR_STOPS[0]!

	return [first[1], first[2], first[3]]
}

/**
 * Generates a seeded star catalog.
 */
export function generateStarfield(options: StarfieldOptions = {}): StarCatalog {
	const count = options.count ?? 20_000
	const bandShare = options.bandShare ?? 0.35
	const random = mulberry32(options.seed ?? 1)
	const data = new Float32Array(count * STAR_STRIDE)

	for (let i = 0; i < count; i++) {
		const galacticLng = random() * 2 * Math.PI

		const galacticLat =
			random() < bandShare
				? Math.max(-Math.PI / 2, Math.min(Math.PI / 2, gaussian(random) * BAND_WIDTH * DEG))
				: Math.asin(2 * random() - 1)

		const cosB = Math.cos(galacticLat)
		const a = cosB * Math.cos(galacticLng)
		const b = cosB * Math.sin(galacticLng)
		const c = Math.sin(galacticLat)

		const magnitude = sampleMagnitude(random())
		// Brightness runs from 0 at the naked-eye limit to 1 at the brightest drawn star.
		const brightness = (MAG_FAINT - magnitude) / (MAG_FAINT - MAG_BRIGHT)
		const [red, green, blue] = starColor(sampleColorIndex(random))

		const offset = i * STAR_STRIDE
		data[offset] = a * GALACTIC_CENTER[0] + b * GALACTIC_THIRD[0] + c * GALACTIC_POLE[0]
		data[offset + 1] = a * GALACTIC_CENTER[1] + b * GALACTIC_THIRD[1] + c * GALACTIC_POLE[1]
		data[offset + 2] = a * GALACTIC_CENTER[2] + b * GALACTIC_THIRD[2] + c * GALACTIC_POLE[2]
		// Most stars sit near the faint limit, so the floors keep them visible as single-pixel points on a display.
		data[offset + 3] = 0.6 + 1.6 * brightness ** 2
		data[offset + 4] = 0.45 + 0.55 * Math.sqrt(brightness)
		data[offset + 5] = red
		data[offset + 6] = green
		data[offset + 7] = blue
	}

	return { count, data }
}

/**
 * The camera's right, up and forward axes in the Earth-fixed frame.
 *
 * The camera sits above the map center and looks toward the Earth.
 * Pitch tilts the view from straight down toward the heading.
 *
 * The map's rotation angle turns the heading clockwise from north.
 */
export interface CameraBasis {
	right: Vec3
	up: Vec3
	forward: Vec3
}

/**
 * Computes the camera axes for a MapLibre camera state.
 */
export function cameraBasis(camera: SkyCamera): CameraBasis {
	const lng = camera.lng * DEG
	const lat = camera.lat * DEG
	const bearing = camera.bearing * DEG
	const pitch = camera.pitch * DEG

	const zenith = unitVector(camera.lng, camera.lat)
	const east: Vec3 = [-Math.sin(lng), Math.cos(lng), 0]
	const north: Vec3 = [-Math.sin(lat) * Math.cos(lng), -Math.sin(lat) * Math.sin(lng), Math.cos(lat)]

	const cosB = Math.cos(bearing)
	const sinB = Math.sin(bearing)
	const heading = combine(north, cosB, east, sinB)
	const right = combine(east, cosB, north, -sinB)

	const cosP = Math.cos(pitch)
	const sinP = Math.sin(pitch)

	return {
		right,
		up: combine(zenith, sinP, heading, cosP),
		forward: combine(zenith, -cosP, heading, sinP),
	}
}

function combine(a: Vec3, wa: number, b: Vec3, wb: number): Vec3 {
	return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb]
}

/**
 * Paints the catalog onto a 2D context for one camera state.
 *
 * `width` and `height` are the canvas size in CSS pixels.
 * The caller scales the context for the device pixel ratio.
 */
export function drawStarfield(
	context: CanvasRenderingContext2D,
	catalog: StarCatalog,
	camera: SkyCamera,
	width: number,
	height: number,
	background: string | null
): void {
	context.clearRect(0, 0, width, height)

	if (background) {
		context.fillStyle = background
		context.fillRect(0, 0, width, height)
	}

	const { right, up, forward } = cameraBasis(camera)
	const focal = height / 2 / Math.tan((camera.fov * DEG) / 2)
	const centerX = width / 2
	const centerY = height / 2
	const { data } = catalog

	for (let i = 0; i < catalog.count; i++) {
		const offset = i * STAR_STRIDE
		const x = data[offset]!
		const y = data[offset + 1]!
		const z = data[offset + 2]!

		const depth = x * forward[0] + y * forward[1] + z * forward[2]

		if (depth <= 0) continue

		const screenX = centerX + (focal * (x * right[0] + y * right[1] + z * right[2])) / depth
		const screenY = centerY - (focal * (x * up[0] + y * up[1] + z * up[2])) / depth
		const radius = data[offset + 3]!

		if (screenX < -radius || screenX > width + radius || screenY < -radius || screenY > height + radius) continue

		context.fillStyle = `rgb(${data[offset + 5]} ${data[offset + 6]} ${data[offset + 7]} / ${data[offset + 4]})`

		// A sub-pixel square anti-aliases into a smear across four pixels, so faint stars snap to one whole pixel.
		if (radius < POINT_RADIUS) {
			context.fillRect(Math.round(screenX), Math.round(screenY), 1, 1)
		} else {
			context.beginPath()
			context.arc(screenX, screenY, radius, 0, 2 * Math.PI)
			context.fill()
		}
	}
}
