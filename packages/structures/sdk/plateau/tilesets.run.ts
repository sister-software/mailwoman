/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regenerates `data/plateau-tilesets.json` from PLATEAU VIEW's catalog.
 *
 *   Usage: node packages/structures/sdk/plateau/tilesets.run.ts
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"

import { electedPlateauTilesets } from "#jp/plateau"
import { createPlateauClient, readPlateauTilesets } from "#sdk/plateau"

const tilesets = await readPlateauTilesets(createPlateauClient(), (url, reason) => {
	console.warn(`skipped ${url}: ${reason}`)
})

const path = resolvePackagePath("@mailwoman/structures", "data", "plateau-tilesets.json")

await writeLocalJSONFile(tilesets, path)

console.log(
	`${tilesets.length} tilesets written to ${path}, ${electedPlateauTilesets(tilesets).length} under the elected site policy`
)
