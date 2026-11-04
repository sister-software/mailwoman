/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Converts PLATEAU building tilesets to the 3D Tiles 1.1 form Earth serves, gzipping every file, under
 *   `<out>/3dtiles/<id>/`, and writes their records to `<out>/city-tilesets.json`.
 *
 *   Usage: node packages/structures/sdk/plateau/convert.run.ts --out <dir> (--city <code> ... | --all)
 *
 *   Only tilesets under the elected PLATEAU site policy are converted. Upload `<out>/3dtiles/` to the tiles bucket's
 *   `3dtiles/` prefix with each object's `Content-Encoding` set to `gzip`, and copy the records into
 *   `packages/structures/data/city-tilesets.json`.
 */

import { gzip } from "@mailwoman/core/fs/compression"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalBuffer, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { CitySource, type CityTileset } from "#city-tilesets"
import { electedPlateauTilesets, type PlateauTileset } from "#jp/plateau"
import { createPlateauTileClient } from "#sdk/plateau"
import { convertB3dm, convertTilesetJSON, type TilesetTile } from "#sdk/three-d-tiles"

const { values } = parseArguments({
	options: {
		out: { type: "string" },
		city: { type: "string", multiple: true },
		all: { type: "boolean", default: false },
	},
})

if (!values.out || (!values.all && !values.city?.length)) {
	throw new Error("usage: convert.run.ts --out <dir> (--city <code> ... | --all)")
}

/**
 * Files downloaded and converted at once.
 */
const CONCURRENCY = 16

const client = createPlateauTileClient()

const plateauTilesets = await readLocalJSONFile<PlateauTileset[]>(
	resolvePackagePath("@mailwoman/structures", "data", "plateau-tilesets.json")
)

const elected = electedPlateauTilesets(plateauTilesets)
const chosen = values.all ? elected : elected.filter((tileset) => values.city!.includes(tileset.cityCode))

/**
 * The tileset's own directory name, such
 * as `13100_tokyo23-ku_city_2025_citygml_1_op_bldg_3dtiles_13101_chiyoda-ku_lod2`.
 */
function directoryOf(url: string): string {
	return url.split("/").at(-2) ?? ""
}

const records: CityTileset[] = []

for (const tileset of chosen) {
	const id = directoryOf(tileset.url)
	const started = Date.now()
	const json = await client.getJSON<{ asset: { version: string }; root: TilesetTile }>(tileset.url)
	const paths = convertTilesetJSON(json)
	let bytes = 0
	let next = 0

	const worker = async () => {
		while (next < paths.length) {
			const path = paths[next++]!
			const source = await client.getBytes(new URL(path, tileset.url).href)
			const converted = path.endsWith(".b3dm") ? convertB3dm(source) : source
			const gzipped = await gzip(converted)

			bytes += gzipped.length
			await writeLocalBuffer(gzipped, values.out!, "3dtiles", id, path.replace(/\.b3dm$/u, ".glb"))
		}
	}

	await Promise.all(Array.from({ length: CONCURRENCY }, worker))
	const root = await gzip(new TextEncoder().encode(stringifyJSON(json)))

	bytes += root.length
	await writeLocalBuffer(root, values.out, "3dtiles", id, "tileset.json")

	records.push({
		id,
		source: CitySource.plateau,
		sourceURL: tileset.url,
		licenseTitle: tileset.licenseTitle,
		bounds: tileset.bounds,
		geoidHeight: tileset.geoidHeight,
		tiles: paths.length,
		bytes,
	})

	console.log(`${id}: ${paths.length} tiles, ${bytes} bytes gzipped, ${Math.round((Date.now() - started) / 1000)} s`)
}

await writeLocalJSONFile(records, values.out, "city-tilesets.json")

console.log(`${records.length} of ${chosen.length} tilesets converted into ${values.out}`)
