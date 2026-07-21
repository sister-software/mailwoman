/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `computeMapPlaceRenderSpec` — the PURE core that replaces the docs demo's ~100-line imperative
 *   marker/bbox/camera redraw effect (`_app.tsx:601-705`). It takes an ALREADY-RESOLVED place (the async
 *   polygon-DB fetch is a host/runtime concern — a later phase — so a crisp polygon arrives pre-fetched
 *   as `place.geometry`) and returns a declarative render spec: the marker position(s), the outline
 *   geometry to draw, and the camera target. No map instance, no DOM, no `react-map-gl` — so it is
 *   node-testable (see `place-render.node.test.ts`). The declarative components in this folder render
 *   the spec; a controlled-viewport consumer applies the camera.
 *
 *   The decision cascade is a faithful, side-effect-free transcription of the imperative effect:
 *     1. street tier (situs / interp)  → exact-radius circle, fly to a tight zoom
 *     2. crisp admin polygon (pre-fetched) → draw the polygon, fit its bounds
 *     3. anchor-centroid postcode (no bbox) → ~3 km "around here" circle, fly to zoom 11
 *     4. bbox with real extent            → bbox-sized approximate circle, fit the bbox
 *     5. bare point                       → no outline, fly to zoom 12
 */

import type { ResolvedPlaceView } from "../pipeline/types.ts"
import { approxCircleGeometry, bboxToBounds, geomBounds, radiusCircleGeometry } from "./geometry.ts"
import type { BoundsTuple, PlaceBBox, PlaceGeometry } from "./geometry.ts"

/** `[longitude, latitude]`. */
export type LngLat = [number, number]

/** The street-level resolution tier (#377): `address_point` = exact building; `interpolated` = TIGER estimate. */
export type PlaceTier = "address_point" | "interpolated"

/**
 * The resolved-place shape the map render consumes — the pipeline {@link ResolvedPlaceView} plus the map-only extras the
 * demo's `ResolvedHit` carries (bbox, street tier + uncertainty), and an optional PRE-FETCHED crisp polygon. Extending
 * `ResolvedPlaceView` keeps the map render aligned with the shared parse result; the extras are additive.
 */
export interface ResolvedMapPlace extends ResolvedPlaceView {
	/** The place's bounding box, when the gazetteer carries one (admin places). Absent for anchor-centroid postcodes. */
	bbox?: PlaceBBox
	/** Street-level tier, when this hit came from the situs/interp tier rather than the WOF admin cascade. */
	tier?: PlaceTier
	/** Honest uncertainty radius in meters for a street-level tier (10 m situs floor; calibrated interp). */
	uncertaintyM?: number
	/**
	 * The crisp admin polygon, when the host has ALREADY fetched it from the sibling polygon DB. Its presence drives the
	 * polygon path; the async fetch itself stays out of this pure function (a runtime concern in a later phase).
	 */
	geometry?: PlaceGeometry
}

/**
 * The camera target the render computes. `center` (fly to a point at a zoom) HAS a declarative equivalent — a consumer
 * can feed it to a controlled `viewState` (see {@link cameraToViewState}). `bounds` (fit a box with pixel padding) does
 * NOT — `fitBounds` needs the map's pixel dimensions, so it is applied imperatively by `<ResultCamera>`.
 */
export type MapCameraTarget =
	| { kind: "center"; center: LngLat; zoom: number }
	| { kind: "bounds"; bounds: BoundsTuple; padding: number }

/** The declarative render spec for one resolved place — the pure output of {@link computeMapPlaceRenderSpec}. */
export interface MapPlaceRenderSpec {
	/** Marker position(s) as `[lon, lat]`. Single-element today; an array leaves room for multi-marker later. */
	markers: LngLat[]
	/** The outline geometry (polygon / circle) to draw, or `null` when the place renders as a bare point. */
	outline: PlaceGeometry | null
	/** The camera target — animate or fit to this. */
	camera: MapCameraTarget
}

/** Zoom levels the imperative effect flew to, kept named so the cascade reads as intent, not magic numbers. */
const ZOOM = {
	addressPoint: 17,
	interpolated: 15,
	postcode: 11,
	point: 12,
} as const

/** Padding (px) `fitBounds` insets a fitted box by, matching the ported effect. */
const FIT_PADDING = 40

/** The minimum lat/lon span (degrees) a bbox must exceed to be treated as a real extent rather than a point. */
const MIN_EXTENT_DEG = 0.001

/**
 * Map a resolved place to its declarative render spec. Pure — same input, same output, no side effects. The `place`
 * arrives fully resolved (crisp polygon pre-fetched into `place.geometry` when available), so this is the honest
 * inverse of the old redraw effect with the imperative map mutation and the async DB load removed.
 */
export function computeMapPlaceRenderSpec(place: ResolvedMapPlace): MapPlaceRenderSpec {
	const markers: LngLat[] = [[place.lon, place.lat]]

	// 1. Street tier (#377): the honest uncertainty circle (exact meter radius) + a tight zoom. Takes precedence over
	//    the admin polygon/bbox paths — a precise point gets no admin boundary.
	if (place.tier && place.uncertaintyM != null) {
		return {
			markers,
			outline: radiusCircleGeometry(place.lat, place.lon, place.uncertaintyM),
			camera: {
				kind: "center",
				center: [place.lon, place.lat],
				zoom: place.tier === "address_point" ? ZOOM.addressPoint : ZOOM.interpolated,
			},
		}
	}

	// 2. Crisp admin polygon (host pre-fetched it from the polygon DB) — draw the real boundary and fit it.
	if (place.geometry) {
		return {
			markers,
			outline: place.geometry,
			camera: { kind: "bounds", bounds: bboxToBounds(geomBounds(place.geometry)), padding: FIT_PADDING },
		}
	}

	// 3. Anchor-centroid postcode: no bbox, no polygon — a default ~3 km circle says "approximately here" without
	//    inventing a boundary.
	if (!place.bbox && place.placetype === "postcode") {
		return {
			markers,
			outline: approxCircleGeometry(place.lat, place.lon),
			camera: { kind: "center", center: [place.lon, place.lat], zoom: ZOOM.postcode },
		}
	}

	// 4. A bbox with real extent — draw an approximate CIRCLE sized from the bbox (a rectangle would read as a wrong,
	//    real boundary) and fit the bbox.
	const bbox = place.bbox

	if (bbox && Math.max(bbox.maxLat - bbox.minLat, bbox.maxLon - bbox.minLon) > MIN_EXTENT_DEG) {
		return {
			markers,
			outline: approxCircleGeometry(place.lat, place.lon, bbox),
			camera: { kind: "bounds", bounds: bboxToBounds(bbox), padding: FIT_PADDING },
		}
	}

	// 5. A bare point (no tier, no polygon, no meaningful bbox) — just a marker and a mid zoom.
	return {
		markers,
		outline: null,
		camera: { kind: "center", center: [place.lon, place.lat], zoom: ZOOM.point },
	}
}

/**
 * The DECLARATIVE camera path: reshape a `center` target into a `viewState` patch a controlled `<DemoMap viewState>`
 * can apply directly (a hard jump, no animation). Returns `null` for a `bounds` target — fitting a box to the viewport
 * needs the map's pixel dimensions, which only the live map has, so that case is applied imperatively by
 * `<ResultCamera>`. Pure + node-testable.
 */
export function cameraToViewState(
	camera: MapCameraTarget
): { longitude: number; latitude: number; zoom: number } | null {
	if (camera.kind !== "center") return null

	return { longitude: camera.center[0], latitude: camera.center[1], zoom: camera.zoom }
}
