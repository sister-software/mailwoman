/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ResolvedPlaceView } from "@mailwoman/core/pipeline/client-result"

import { approxCircleGeometry, bboxToBounds, geomBounds, radiusCircleGeometry } from "#map/geometry"
import type { BoundsTuple, PlaceBBox, PlaceGeometry } from "#map/geometry"

/**
 * `[longitude, latitude]`.
 */
export type LngLat = [number, number]

/**
 * Identifies how a street-level result was located: `address_point` is an exact
 * building point and `interpolated` is a TIGER range estimate.
 */
export type PlaceTier = "address_point" | "interpolated"

/**
 * Describes a resolved place as the map renders it: the shared {@link ResolvedPlaceView}
 * plus an optional bbox, street tier with uncertainty radius, and pre-fetched polygon.
 */
export interface ResolvedMapPlace extends ResolvedPlaceView {
	/**
	 * The place's bounding box when the gazetteer carries one, which anchor-centroid postcodes do not.
	 */
	bbox?: PlaceBBox

	/**
	 * The street-level tier, set only when the result came from address points
	 * or interpolation rather than the admin cascade.
	 */
	tier?: PlaceTier

	/**
	 * The uncertainty radius in meters for a street-level result, drawn as a circle when `tier` is set.
	 */
	uncertaintyM?: number

	/**
	 * The admin polygon, when the host has already fetched it; its presence makes
	 * the outline and camera follow the polygon.
	 */
	geometry?: PlaceGeometry
}

/**
 * Describes where the map camera should go: a `center` point at a zoom,
 * or `bounds` to fit with pixel padding.
 *
 * Only `center` can be applied declaratively through {@link cameraToViewState}, because
 * fitting bounds needs the map's pixel size and so `<ResultCamera>` applies it imperatively.
 */
export type MapCameraTarget =
	| { kind: "center"; center: LngLat; zoom: number }
	| { kind: "bounds"; bounds: BoundsTuple; padding: number }

/**
 * The declarative render spec for one resolved place — the pure output of {@link computeMapPlaceRenderSpec}.
 */
export interface MapPlaceRenderSpec {
	/**
	 * The marker positions as `[lon, lat]`, currently always a single marker.
	 */
	markers: LngLat[]

	/**
	 * The polygon or circle outline to draw, or `null` when the place renders as a bare point.
	 */
	outline: PlaceGeometry | null

	/**
	 * The point to center on or the bounds to fit.
	 */
	camera: MapCameraTarget
}

const ZOOM = {
	addressPoint: 17,
	interpolated: 15,
	postcode: 11,
	point: 12,
} as const

const FIT_PADDING = 40

const MIN_EXTENT_DEG = 0.001

/**
 * Computes the markers, outline and camera target for a resolved place without side effects.
 *
 * It expects any crisp polygon to be pre-fetched into `place.geometry`, since it performs no loading.
 */
export function computeMapPlaceRenderSpec(place: ResolvedMapPlace): MapPlaceRenderSpec {
	const markers: LngLat[] = [[place.lon, place.lat]]

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

	if (place.geometry) {
		return {
			markers,
			outline: place.geometry,
			camera: { kind: "bounds", bounds: bboxToBounds(geomBounds(place.geometry)), padding: FIT_PADDING },
		}
	}

	if (!place.bbox && place.placetype === "postcode") {
		return {
			markers,
			outline: approxCircleGeometry(place.lat, place.lon),
			camera: { kind: "center", center: [place.lon, place.lat], zoom: ZOOM.postcode },
		}
	}

	const bbox = place.bbox

	if (bbox && Math.max(bbox.maxLat - bbox.minLat, bbox.maxLon - bbox.minLon) > MIN_EXTENT_DEG) {
		return {
			markers,
			outline: approxCircleGeometry(place.lat, place.lon, bbox),
			camera: { kind: "bounds", bounds: bboxToBounds(bbox), padding: FIT_PADDING },
		}
	}

	return {
		markers,
		outline: null,
		camera: { kind: "center", center: [place.lon, place.lat], zoom: ZOOM.point },
	}
}

/**
 * Converts a `center` camera target into a `viewState` patch that a controlled
 * `<MapCanvas>` applies as a jump.
 *
 * It returns `null` for a `bounds` target, which `<ResultCamera>` must fit imperatively.
 */
export function cameraToViewState(
	camera: MapCameraTarget
): { longitude: number; latitude: number; zoom: number } | null {
	if (camera.kind !== "center") return null

	return { longitude: camera.center[0], latitude: camera.center[1], zoom: camera.zoom }
}
