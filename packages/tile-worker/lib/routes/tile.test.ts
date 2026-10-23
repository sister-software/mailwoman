import { describe, expect, test } from "vitest"

import { TileMetadataRoute, TileRoute } from "./tile.ts"

describe("tile routes", () => {
	test("a tile set name with a dot reaches its TileJSON and its tiles", () => {
		expect(TileMetadataRoute.pattern.matchParams({ pathname: "/planet.v4.json" })).toEqual({ tileSetName: "planet.v4" })

		expect(TileRoute.pattern.matchParams({ pathname: "/planet.v4/15/29103/12905.mvt" })).toMatchObject({
			tileSetName: "planet.v4",
			z: "15",
			fileExtension: "mvt",
		})
	})

	test("a hyphenated tile set name still matches", () => {
		expect(TileMetadataRoute.pattern.matchParams({ pathname: "/coverage-v5.json" })).toEqual({
			tileSetName: "coverage-v5",
		})
	})
})
