// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The landmarks the map draws from a model in place of their footprint.
 *
 *   `data/landmarks.json` lists them.
 *   Three readers share the list: hrt leaves each landmark's footprints out of the
 *   building tiles, Earth hides those footprints in tiles built before the landmark
 *   joined the list, and Earth draws the model at the landmark's anchor.
 */

import { readAccessor, readGLB } from "#glb"

/**
 * How Earth gets a landmark's mesh.
 */
export const LandmarkModelFormat = {
	/**
	 * A binary glTF the tile worker serves from the tiles bucket.
	 */
	GLB: "glb",
	/**
	 * A mesh Earth builds in code from the landmark's dimensions,
	 * in `packages/earth/lib/scene/meshes.ts`, keyed by the landmark's id.
	 */
	Procedural: "procedural",
} as const

export type LandmarkModelFormat = (typeof LandmarkModelFormat)[keyof typeof LandmarkModelFormat]

/**
 * A model converted from a published file.
 */
export interface LandmarkGLBModel {
	format: typeof LandmarkModelFormat.GLB
	/**
	 * The structure register source whose license decision covers the model.
	 */
	source: string
	/**
	 * The file the converter reads, pinned to one revision.
	 */
	sourceURL: string
	/**
	 * The converted model's key in the tiles bucket and its path on the tile worker,
	 * such as `landmarks/eiffel-tower.glb`.
	 */
	path: string
}

export interface LandmarkProceduralModel {
	format: typeof LandmarkModelFormat.Procedural
}

export type LandmarkModel = LandmarkGLBModel | LandmarkProceduralModel

/**
 * One landmark.
 */
export interface Landmark {
	/**
	 * A lowercase hyphenated name, stable across releases.
	 */
	id: string
	name: string
	/**
	 * The Wikidata item, such as `Q243`.
	 */
	wikidata: string
	/**
	 * The OpenStreetMap element, such as `way/5013364`.
	 */
	osm: string
	/**
	 * Longitude and latitude of the model's origin, the center of its base.
	 */
	anchor: [number, number]
	/**
	 * The height in meters the map draws the model at.
	 *
	 * A converted model is scaled uniformly to this height.
	 * It can differ from the structure's tagged height when the model omits antennas.
	 */
	height: number
	/**
	 * Degrees clockwise, seen from above, that the model turns about its origin.
	 */
	yaw: number
	/**
	 * The color the map draws a converted model in, as `#rrggbb`.
	 */
	color?: string
	/**
	 * The radius in meters around the anchor inside which a building footprint's centroid
	 * marks it as part of the landmark, so the map leaves that footprint out.
	 */
	suppressRadius: number
	model: LandmarkModel
}

/**
 * Whether a landmark's model is a converted glTF.
 */
export function isGLBLandmark(landmark: Landmark): landmark is Landmark & { model: LandmarkGLBModel } {
	return landmark.model.format === LandmarkModelFormat.GLB
}

/**
 * A converted landmark model's triangles in the map's axes: x east, y north
 * and z up, in meters from the anchor.
 */
export interface LandmarkMesh {
	positions: Float32Array
	indices: Uint32Array
}

/**
 * Reads a model written by the landmark converter.
 *
 * The model holds one mesh of one triangle primitive in glTF's axes.
 *
 * glTF's x east, y up and z south become x east, y north and z up.
 * The change is a rotation, so each triangle keeps its winding.
 *
 * @throws When the file holds other than one mesh with one primitive.
 */
export function readLandmarkMesh(glb: Uint8Array): LandmarkMesh {
	const { document, binary } = readGLB(glb)
	const primitives = document.meshes?.flatMap((mesh) => mesh.primitives) ?? []

	if (primitives.length !== 1 || primitives[0]!.indices == null) {
		throw new Error(`a converted landmark model holds one indexed primitive, not ${primitives.length}`)
	}

	const [primitive] = primitives as [(typeof primitives)[number]]
	const source = readAccessor(document, binary, primitive.attributes["POSITION"]!, 3)
	const positions = new Float32Array(source.length)

	for (let i = 0; i < source.length; i += 3) {
		positions[i] = source[i]!
		positions[i + 1] = -source[i + 2]!
		positions[i + 2] = source[i + 1]!
	}

	return { positions, indices: Uint32Array.from(readAccessor(document, binary, primitive.indices!, 1)) }
}

/**
 * Meters per degree of latitude and, at the equator, of longitude, as hrt's footprint test uses them.
 */
const METERS_PER_DEGREE_LATITUDE = 110_540
const METERS_PER_DEGREE_LONGITUDE = 111_320

/**
 * The `[west, south, east, north]` square that encloses a landmark's suppression circle.
 */
export function landmarkBounds({
	anchor: [longitude, latitude],
	suppressRadius,
}: Landmark): [number, number, number, number] {
	const dLongitude = suppressRadius / (METERS_PER_DEGREE_LONGITUDE * Math.cos((latitude * Math.PI) / 180))
	const dLatitude = suppressRadius / METERS_PER_DEGREE_LATITUDE

	return [longitude - dLongitude, latitude - dLatitude, longitude + dLongitude, latitude + dLatitude]
}

/**
 * The landmark whose suppression radius contains a point, or `null` when none does.
 *
 * hrt's `is_modeled_landmark` applies the same test to a footprint's centroid.
 */
export function landmarkCovering(landmarks: readonly Landmark[], longitude: number, latitude: number): Landmark | null {
	for (const landmark of landmarks) {
		const [anchorLongitude, anchorLatitude] = landmark.anchor
		const dx = (longitude - anchorLongitude) * METERS_PER_DEGREE_LONGITUDE * Math.cos((anchorLatitude * Math.PI) / 180)
		const dy = (latitude - anchorLatitude) * METERS_PER_DEGREE_LATITUDE

		if (Math.hypot(dx, dy) <= landmark.suppressRadius) return landmark
	}

	return null
}
