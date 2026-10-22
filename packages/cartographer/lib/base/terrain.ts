/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { RasterDEMSourceSpecification } from "@maplibre/maplibre-gl-style-spec"

import { TileSetSourceID } from "#styles/sources"

/**
 * Creates a raster DEM source specification for terrain data.
 */
export function createTerrainDEMSource(): RasterDEMSourceSpecification {
	const terrainSource: RasterDEMSourceSpecification = {
		type: "raster-dem",
		encoding: "terrarium",
		tiles: ["https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png"],
		tileSize: 256,
		maxzoom: 15,
	}

	return terrainSource
}

/**
 * Creates the raster DEM source the ocean layers read: the same terrarium tiles, capped at z10.
 *
 * The terrain tiles hold bathymetry only through z10.
 * From z11 every ocean pixel reads 0 m, so a source that loaded z11 tiles would draw a flat sea floor.
 *
 * Capped at z10, MapLibre overzooms the last tiles that hold depths.
 */
export function createBathymetryDEMSource(): RasterDEMSourceSpecification {
	return { ...createTerrainDEMSource(), maxzoom: 10 }
}

/**
 * Identifier for the bathymetry source the ocean layers read.
 */
export const BathymetryTileSetID = TileSetSourceID("bathymetry")

/**
 * Identifier for the Nexus terrain tileset.
 */
export const HillshadeTileSetID = TileSetSourceID("hillshade")
