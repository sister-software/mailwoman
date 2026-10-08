/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Download Geofabrik extracts into `$MAILWOMAN_DATA_ROOT/db/osm/geofabrik` and write a receipt beside each.
 *
 *   A file takes the name `<leaf>-<YYMMDD>.osm.pbf` from the server's `Last-Modified` date. That name
 *   matches the extracts already on disk (`pakistan-260819.osm.pbf`). A file already present under that
 *   name is kept, and its receipt is written only when missing.
 *
 *   Usage:
 *     node packages/osm/tools/fetch/extract.ts --region russia --region asia/china
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { osmDatabasePath } from "#paths"
import { downloadExtract, geofabrikURL } from "#sdk/fetch"

const { values } = parseArguments({
	options: {
		region: { type: "string", multiple: true },
		dir: { type: "string" },
	},
})

const regions = values.region ?? []

if (!regions.length) throw new Error("usage: fetch-extract --region <geofabrik/path> [--region …] [--dir <dir>]")

const directory = values.dir ?? osmDatabasePath("geofabrik").toString()

await makeDirectories(directory)

for (const region of regions) {
	const head = await fetch(geofabrikURL(region), { method: "HEAD" })

	if (!head.ok) throw new Error(`Geofabrik HEAD failed (${head.status}) for ${region}`)

	const modified = head.headers.get("last-modified")

	if (!modified) throw new Error(`Geofabrik sent no Last-Modified for ${region}; the file cannot be dated`)

	const stamp = new Date(modified).toISOString().slice(2, 10).replaceAll("-", "")
	const leaf = region.split("/").at(-1)!
	const destination = `${directory}/${leaf}-${stamp}.osm.pbf`
	const receiptPath = `${destination}.receipt.json`

	if (await pathExists(destination)) {
		console.log(`[osm] ${destination} present; skipped`)

		continue
	}

	console.log(`[osm] ${region} → ${destination} (${head.headers.get("content-length")} bytes, ${modified})`)

	const receipt = await downloadExtract(region, destination)

	await writeLocalJSONFile(receipt, receiptPath)

	console.log(`[osm] ${destination}: ${receipt.bytes} bytes, sha256 ${receipt.sha256}`)
}
