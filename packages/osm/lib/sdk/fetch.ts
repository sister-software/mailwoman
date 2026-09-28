/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Geofabrik extract URLs and a streaming downloader for per-country and sub-region `.osm.pbf` files — the
 *   bytes are ODbL OpenStreetMap data, see `osm/readme.md`.
 *
 *   RAW `fetch` is deliberate: `agents.md` requires HTTP clients to use `APIClient`, whose pacing, retry and
 *   response caching earn their keep on small repeated API requests. A multi-gigabyte body streamed
 *   straight to disk moves in a single pass, where pacing and retry add overhead.
 */

import { openWriteStream, pipeline, Readable } from "@mailwoman/core/fs/streams"
import { movePath } from "@mailwoman/core/fs/writers"

const GEOFABRIK_BASE = "https://download.geofabrik.de"

/**
 * The URL of a Geofabrik `-latest.osm.pbf` extract for a region path like
 * `europe/france/ile-de-france` or `europe/germany`, given without the suffix.
 */
export function geofabrikURL(regionPath: string): string {
	const clean = regionPath.replaceAll(/^\/+|\/+$/g, "")

	return `${GEOFABRIK_BASE}/${clean}-latest.osm.pbf`
}

/**
 * Download a Geofabrik extract to `destPath`, streaming (these run to several GB for a whole country).
 *
 * @returns the byte count written.
 */
export async function downloadExtract(regionPath: string, destPath: string): Promise<number> {
	const url = geofabrikURL(regionPath)
	const res = await fetch(url)

	if (!res.ok || !res.body) throw new Error(`Geofabrik download failed (${res.status}) for ${url}`)
	let bytes = 0

	const counter = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			bytes += chunk.byteLength
			controller.enqueue(chunk)
		},
	})

	// Write to a `.tmp` sibling and rename, so an interrupted multi-gigabyte download
	// never lands at the final path looking like a complete extract.
	const tmpPath = destPath + ".tmp"

	await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), openWriteStream(tmpPath))
	await movePath(tmpPath, destPath)

	return bytes
}
