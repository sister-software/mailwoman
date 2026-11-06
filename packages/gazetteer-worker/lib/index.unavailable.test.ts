/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This file puts no database in the buckets, so every landmark read finds its object absent.
 */

import { env, exports } from "cloudflare:workers"
import { describe, expect, test } from "vitest"

import { OSM_PLACES_DATABASE_KEY } from "#index"

describe("the landmark route with an absent database", () => {
	test("answers 503 with the cross-origin header, so a browser reads the status", async () => {
		expect(await env.OSM_PLACES_BUCKET.head(OSM_PLACES_DATABASE_KEY)).toBeNull()

		const response = await exports.default.fetch("https://places.invalid/v1/landmarks?name=Anal&source=openstreetmap")

		expect(response.status).toBe(503)
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*")
		expect(response.headers.get("Cache-Control")).toBeNull()
	})
})
