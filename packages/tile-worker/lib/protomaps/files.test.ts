/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { TileType } from "pmtiles"
import { expect, test } from "vitest"

import { TileFileExtensionMap, TileTypeFileExtensionMap, TileTypeToContentType } from "#protomaps/files"

test("a .bin tile reads an archive of tile type Unknown, whose TileJSON names .bin tiles", () => {
	expect(TileFileExtensionMap.get("bin")).toBe(TileType.Unknown)
	expect(TileTypeFileExtensionMap.get(TileType.Unknown)).toBe("bin")
	expect(TileTypeToContentType[TileType.Unknown]).toBe("application/octet-stream")
})

test("each tile type maps back to the extension that names it", () => {
	for (const [extension, tileType] of TileFileExtensionMap) {
		expect(TileTypeFileExtensionMap.get(tileType)).toBe(extension)
	}
})
