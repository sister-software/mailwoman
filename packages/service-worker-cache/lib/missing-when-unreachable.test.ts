/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { missingWhenUnreachablePlugin, UNREACHABLE_HEADER } from "#missing-when-unreachable"

describe("missingWhenUnreachablePlugin", () => {
	test("handlerDidError answers a marked 404, the status MapLibre reads as a tile that does not exist", async () => {
		const { handlerDidError } = missingWhenUnreachablePlugin()
		const request = new Request("https://tiles.example.test/planet.v4/11/605/768.mvt")

		const response = await handlerDidError!({
			request,
			event: {} as ExtendableEvent,
			error: new TypeError("Failed to fetch"),
		})

		expect(response?.status).toBe(404)
		expect(response?.headers.get(UNREACHABLE_HEADER)).toBe("1")
	})
})
