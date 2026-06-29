/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Geofabrik extract URLs + a streaming downloader. Geofabrik is the OSM ecosystem's de-facto
 *   regional-extract host: a cascade of continent → country → sub-region `.osm.pbf` files
 *   (`europe/france/ile-de-france-latest.osm.pbf`). We pull per-COUNTRY extracts (the ecosystem's
 *   default shard unit — matching Photon's per-country dumps and our own per-locale weights), and a
 *   smaller sub-region extract when we only need to smoke a build (Île-de-France for the Paris
 *   acceptance). The bytes are ODbL OpenStreetMap data — see `osm/README.md`.
 */

import { createWriteStream } from "node:fs"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

const GEOFABRIK_BASE = "https://download.geofabrik.de"

/**
 * The URL of a Geofabrik `-latest.osm.pbf` extract for a region path like `europe/france/ile-de-france`
 * or `europe/germany`. Pass the path WITHOUT the `-latest.osm.pbf` suffix.
 */
export function geofabrikUrl(regionPath: string): string {
	const clean = regionPath.replace(/^\/+|\/+$/g, "")

	return `${GEOFABRIK_BASE}/${clean}-latest.osm.pbf`
}

/**
 * Download a Geofabrik extract to `destPath`, streaming (these run to several GB for a whole country).
 * Returns the byte count written. The caller owns where the file lands (typically
 * `$MAILWOMAN_DATA_ROOT/osm/geofabrik/`).
 */
export async function downloadExtract(regionPath: string, destPath: string): Promise<number> {
	const url = geofabrikUrl(regionPath)
	const res = await fetch(url)

	if (!res.ok || !res.body) throw new Error(`Geofabrik download failed (${res.status}) for ${url}`)
	let bytes = 0
	const counter = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			bytes += chunk.byteLength
			controller.enqueue(chunk)
		},
	})

	await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), createWriteStream(destPath))

	return bytes
}
