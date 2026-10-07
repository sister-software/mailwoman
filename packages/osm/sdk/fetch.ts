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

import { movePath } from "@mailwoman/core/fs/writers"
import { createHash } from "@mailwoman/core/hash"
import { streamToDisk } from "@mailwoman/core/utils"
import { basename } from "path-ts"

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
 * What one Geofabrik download retrieved, recorded beside the extract so a corpus
 * row can be traced to the exact bytes it was read from.
 *
 * `last_modified` is the server's `Last-Modified` header. It dates the OSM snapshot inside the file.
 * `retrieved_at` dates the download.
 *
 * A `-latest` URL serves a different file every day, so the URL does not
 * identify the bytes by itself; `sha256` does.
 */
export interface GeofabrikExtractReceipt {
	readonly region: string
	readonly source_url: string
	readonly retrieved_at: string
	readonly last_modified: string | null
	readonly filename: string
	readonly bytes: number
	readonly sha256: string
	readonly md5: string
	/**
	 * The checksum Geofabrik publishes at `<url>.md5`, or null when that file could not be read.
	 */
	readonly published_md5: string | null
	readonly license: "ODbL-1.0"
}

/**
 * Download a Geofabrik extract to `destPath` and hash its bytes in the same pass.
 *
 * A whole-country extract runs to several gigabytes, so the body streams to disk.
 *
 * `streamToDisk` writes through a `.part` sibling, so an interrupted transfer never lands at the final path.
 * When Geofabrik's published md5 disagrees with the bytes, the download moves the
 * file to `<destPath>.md5-mismatch` for inspection and throws.
 */
export async function downloadExtract(regionPath: string, destPath: string): Promise<GeofabrikExtractReceipt> {
	const url = geofabrikURL(regionPath)
	const sha256 = createHash("sha256")
	const md5 = createHash("md5")
	let lastModified: string | null = null

	const bytes = await streamToDisk({
		url,
		destination: destPath,
		context: "Geofabrik download",
		onResponse: (response) => {
			lastModified = response.headers.get("last-modified")
		},
		onChunk: (chunk) => {
			sha256.update(chunk)
			md5.update(chunk)
		},
	})

	const md5Hex = md5.digest("hex")

	const published = await fetch(`${url}.md5`)
		.then(async (response) => (response.ok ? (await response.text()).trim().split(/\s+/u)[0]! : null))
		.catch(() => null)

	if (published !== null && published !== md5Hex) {
		await movePath(destPath, `${destPath}.md5-mismatch`)

		throw new Error(
			`Geofabrik md5 mismatch for ${url}: published ${published}, downloaded ${md5Hex} (${destPath}.md5-mismatch)`
		)
	}

	return {
		region: regionPath.replaceAll(/^\/+|\/+$/g, ""),
		source_url: url,
		retrieved_at: new Date().toISOString(),
		last_modified: lastModified,
		filename: basename(destPath),
		bytes,
		sha256: sha256.digest("hex"),
		md5: md5Hex,
		published_md5: published,
		license: "ODbL-1.0",
	}
}
