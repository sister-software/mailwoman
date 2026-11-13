// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The memory figures Earth can account for itself, gathered for the Developer sheet's readout.
 *
 *   Each figure comes from the page's own bookkeeping rather than from a process measurement.
 *   The readout labels each figure and marks the ones it can't read.
 */

/**
 * The bytes MapLibre keeps for each cached vector tile, measured on a tilted street view
 * over dense building extrusions in central Osaka: about 64 MB for 52 tiles.
 * Flat views hold less, so the estimate is an upper figure.
 */
export const MAPLIBRE_BYTES_PER_TILE = 1.2 * 1024 * 1024

/**
 * The parts of MapLibre's map the tile estimate reads.
 *
 * `style.tileManagers` is internal to MapLibre 5 and may be absent in another version,
 * in which case the estimate returns `null`.
 */
interface TileCountingMap {
	style?: { tileManagers?: Record<string, { getIds(): string[] }> }
	_maxTileCacheSize?: number | null
}

let modelBytes: number | null = null
let map: TileCountingMap | null = null

/**
 * Records the loaded model's size, or `null` when the classifier reports none.
 */
export function reportModelBytes(bytes: number | null): void {
	modelBytes = bytes
}

export function loadedModelBytes(): number | null {
	return modelBytes
}

/**
 * Records the map the tile estimate reads, and returns a function that forgets it.
 */
export function registerMemoryMap(next: TileCountingMap): () => void {
	map = next

	return () => {
		if (map === next) {
			map = null
		}
	}
}

/**
 * MapLibre's tiles in view, its out-of-view cache limit, and the bytes both would
 * hold at {@linkcode MAPLIBRE_BYTES_PER_TILE}, or `null` when no map is registered
 * or its tile managers can't be read.
 */
export function mapTileEstimate(): { inView: number; cacheLimit: number; bytes: number } | null {
	const managers = map?.style?.tileManagers

	if (!managers) return null

	let inView = 0

	try {
		for (const manager of Object.values(managers)) {
			inView += manager.getIds().length
		}
	} catch {
		return null
	}

	const cacheLimit = map?._maxTileCacheSize ?? 0

	return { inView, cacheLimit, bytes: (inView + cacheLimit) * MAPLIBRE_BYTES_PER_TILE }
}
