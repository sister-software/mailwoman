// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * TileJSON is an open standard for representing map metadata.
 *
 * @see {@link https://github.com/mapbox/tilejson-spec TileJSON Specification}
 */
export interface TileJSON {
	/**
	 * The version of the TileJSON spec that is implemented by this JSON object.
	 *
	 * @default "3.0.0"
	 */
	tilejson: string
	scheme: "xyz"
	tiles: string[]
	vector_layers: TileJSONVectorLayer[]
	attribution?: string
	description?: string
	name: string
	version: string
	bounds: [minLon: number, minLat: number, maxLon: number, maxLat: number]
	center: [centerLon: number, centerLat: number, centerZoom: number]
	minzoom: number
	maxzoom: number
}

/**
 * A vector layer definition for a TileJSON object.
 */
export interface TileJSONVectorLayer {
	description?: string
	id: string
	fields: Record<string, string>
	source: string
	minzoom?: number
	maxzoom?: number
}
