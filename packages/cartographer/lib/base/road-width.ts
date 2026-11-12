// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { stringifyJSON } from "@mailwoman/core/json"
import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl"

/**
 * Carriageway width per OSM lane, in meters.
 */
const LANE_WIDTH_METERS = 3.25

/**
 * The latitude at which a road's drawn width equals its ground width.
 *
 * A style expression cannot read the latitude, so one reference latitude
 * converts meters to pixels everywhere.
 * At 40° the drawn width is within 25% of the ground width from the equator to 55°.
 */
const REFERENCE_LATITUDE = 40

const EARTH_CIRCUMFERENCE_METERS = 40_075_016.686

/**
 * MapLibre's world is 512 pixels wide at zoom 0.
 */
const WORLD_PIXELS_AT_ZOOM_0 = 512

/**
 * The highest zoom the width curve has a stop at.
 * MapLibre holds the last stop's value above it.
 */
const MAX_WIDTH_ZOOM = 24

/**
 * Pixels per ground meter at a zoom, at the reference latitude.
 */
export function pixelsPerMeter(zoom: number): number {
	const groundMeters = EARTH_CIRCUMFERENCE_METERS * Math.cos((REFERENCE_LATITUDE * Math.PI) / 180)

	return (WORLD_PIXELS_AT_ZOOM_0 * 2 ** zoom) / groundMeters
}

/**
 * A road's carriageway width in meters: its OSM `width` tag, else its `lanes` tag
 * times the lane width, else the typical width of its class.
 *
 * The build writes `width` and `lanes` from z15.
 * Below z15 every road takes its class width.
 * A `width` outside 2–60 m is clamped into that range.
 */
function groundWidth(classMeters: number | ExpressionSpecification): ExpressionSpecification {
	return [
		"case",
		["has", "width"],
		["max", 2, ["min", 60, ["to-number", ["get", "width"], 0]]],
		["has", "lanes"],
		["*", LANE_WIDTH_METERS, ["to-number", ["get", "lanes"], 1]],
		classMeters,
	]
}

/**
 * The typical carriageway width of each road class, in meters, for a road without `width` or `lanes`.
 *
 * A dual carriageway is two OSM ways, so a highway's width is one direction's.
 */
const CLASS_WIDTH_METERS = {
	highway: 11,
	major: ["match", ["get", "kind_detail"], ["trunk", "primary"], 12, "secondary", 10, 8],
	link: 6.5,
	minor: ["match", ["get", "kind_detail"], "service", 4, 6],
	other: ["match", ["get", "kind"], "path", 2.5, 4],
	runway: 45,
	taxiway: 23,
} as const satisfies Record<string, number | ExpressionSpecification>

type RoadClass = keyof typeof CLASS_WIDTH_METERS

/**
 * The road class a Protomaps road layer draws, from its layer id, or `null`
 * for a layer drawn at a fixed scale.
 */
export function roadClassOf(layerID: string): RoadClass | null {
	if (!layerID.startsWith("roads_")) return null

	if (layerID === "roads_runway") return "runway"

	if (layerID === "roads_taxiway") return "taxiway"

	for (const roadClass of ["highway", "major", "link", "minor", "other"] as const) {
		if (layerID.includes(`_${roadClass}`)) return roadClass
	}

	return null
}

/**
 * The value of a Protomaps exponential zoom curve at a zoom.
 */
function evaluateCurve(curve: unknown, zoom: number): number {
	const [operator, type, input, ...stops] = curve as [unknown, unknown, unknown, ...number[]]
	const base = Array.isArray(type) && type[0] === "exponential" ? Number(type[1]) : 1

	if (operator !== "interpolate" || !Array.isArray(input) || input[0] !== "zoom" || stops.length < 2) {
		throw new Error(`expected a zoom interpolation, found ${stringifyJSON(curve)}`)
	}

	if (zoom <= stops[0]!) return stops[1]!

	for (let index = 2; index < stops.length; index += 2) {
		const [z0, v0, z1, v1] = [stops[index - 2]!, stops[index - 1]!, stops[index]!, stops[index + 1]!]

		if (zoom <= z1) {
			const t = base === 1 ? (zoom - z0) / (z1 - z0) : (base ** (zoom - z0) - 1) / (base ** (z1 - z0) - 1)

			return v0 + t * (v1 - v0)
		}
	}

	return stops.at(-1)!
}

/**
 * A road body width that's the wider of the Protomaps curve and the road's ground width at every zoom.
 *
 * At low zoom the Protomaps curve keeps a road visible.
 * At street zoom the ground width takes over, so a road keeps its footprint as the map scales.
 *
 * The curve interpolates exponentially with base 2 between integer zoom stops.
 * The map doubles in scale per zoom, so base 2 gives the exact ground width between stops.
 */
export function roadBodyWidth(protomapsCurve: unknown, roadClass: RoadClass): ExpressionSpecification {
	const stops = (protomapsCurve as number[]).slice(3)
	const firstZoom = stops[0]!
	const zooms = new Set<number>(stops.filter((_, index) => index % 2 === 0))

	for (let zoom = Math.ceil(firstZoom); zoom <= MAX_WIDTH_ZOOM; zoom++) {
		zooms.add(zoom)
	}

	const meters = groundWidth(CLASS_WIDTH_METERS[roadClass])
	const output: Array<number | ExpressionSpecification> = []

	for (const zoom of [...zooms].toSorted((a, b) => a - b)) {
		const protomaps = Number(evaluateCurve(protomapsCurve, zoom).toFixed(3))
		output.push(zoom, ["max", protomaps, ["*", meters, Number(pixelsPerMeter(zoom).toPrecision(6))]])
	}

	return ["interpolate", ["exponential", 2], ["zoom"], ...output] as ExpressionSpecification
}

/**
 * Replaces a road layer's body width with {@link roadBodyWidth}.
 *
 * A road fill sets the body as `line-width`.
 * A casing sets it as `line-gap-width` and keeps its own `line-width` as the outline.
 */
export function withGroundWidth<T extends LayerSpecification>(layer: T): T {
	const roadClass = roadClassOf(layer.id)

	if (!roadClass || layer.type !== "line" || !layer.paint) return layer

	const paint = { ...layer.paint }
	const gap = paint["line-gap-width"]

	if (gap != null) {
		paint["line-gap-width"] = roadBodyWidth(gap, roadClass)
	} else if (paint["line-width"] != null) {
		paint["line-width"] = roadBodyWidth(paint["line-width"], roadClass)
	}

	return { ...layer, paint }
}
