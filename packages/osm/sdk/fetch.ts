import { openWriteStream } from "@mailwoman/core/fs/streams"
import { Readable } from "@mailwoman/platform/stream"
import { pipeline } from "@mailwoman/platform/stream/promises"

const GEOFABRIK_BASE = "https://download.geofabrik.de"

/**
 * The URL of a Geofabrik `-latest.osm.pbf` extract for a region path like `europe/france/ile-de-france` or
 * `europe/germany`. Pass the path WITHOUT the `-latest.osm.pbf` suffix.
 */
export function geofabrikURL(regionPath: string): string {
	const clean = regionPath.replaceAll(/^\/+|\/+$/g, "")

	return `${GEOFABRIK_BASE}/${clean}-latest.osm.pbf`
}

/**
 * Download a Geofabrik extract to `destPath`, streaming (these run to several GB for a whole country). Returns the byte
 * count written. The caller owns where the file lands (typically `$MAILWOMAN_DATA_ROOT/osm/geofabrik/`).
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

	await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), openWriteStream(destPath))

	return bytes
}
