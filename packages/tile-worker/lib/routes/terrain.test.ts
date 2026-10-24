import { describe, expect, test } from "vitest"

import { TerrariumTileRoute } from "./terrain.ts"
import { TileRoute } from "./tile.ts"

describe("terrarium tile route", () => {
	test("a terrarium path reaches the terrain route", () => {
		expect(TerrariumTileRoute.pattern.matchParams({ pathname: "/terrain/terrarium/10/909/403.png" })).toEqual({
			z: "10",
			x: "909",
			y: "403",
		})
	})

	test("a terrarium path leaves the PMTiles tile route alone", () => {
		expect(TileRoute.pattern.matchParams({ pathname: "/terrain/terrarium/10/909/403.png" })).toBeFalsy()
	})
})
