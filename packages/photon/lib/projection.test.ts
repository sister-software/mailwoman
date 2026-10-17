/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A Photon feature states the register row behind its coordinate under `properties.mailwoman`, and carries
 *   the OpenStreetMap credit there exactly when that row came from an OpenStreetMap layer.
 */

import { OPENSTREETMAP_CREDIT } from "@mailwoman/core/geocode"
import { stringifyJSON } from "@mailwoman/core/json"
import { describe, expect, it } from "vitest"

import { photonForwardCollection, photonForwardProperties, type PhotonForwardInput } from "#projection"

const THAMES: PhotonForwardInput = {
	lat: -37.137364,
	lon: 175.541779,
	country: { name: "New Zealand", code: "NZ" },
	places: [{ tag: "locality", name: "Thames" }],
	house: { number: "620B", street: "Pollen Street" },
}

describe("photonForwardProperties", () => {
	it("keeps an OpenStreetMap row's stamp and attaches the OpenStreetMap credit", () => {
		const props = photonForwardProperties({
			...THAMES,
			coordinateSource: { source: "openstreetmap:nz", release: "2026-08-06" },
		})

		expect(props.mailwoman).toEqual({
			coordinate_source: { source: "openstreetmap:nz", release: "2026-08-06" },
			attribution: OPENSTREETMAP_CREDIT,
		})

		expect(props.type).toBe("house")
	})

	it("reports a non-OSM row under its own stamp and never gains the OpenStreetMap credit", () => {
		const props = photonForwardProperties({
			...THAMES,
			coordinateSource: { source: "overture:NAD", release: "2026-05-20.0" },
		})

		expect(props.mailwoman).toEqual({ coordinate_source: { source: "overture:NAD", release: "2026-05-20.0" } })
		expect(stringifyJSON(props)).not.toContain("OpenStreetMap")
	})

	it("carries no block when no register row placed the coordinate", () => {
		expect(photonForwardProperties(THAMES).mailwoman).toBeUndefined()
	})
})

describe("photonForwardCollection", () => {
	it("stamps the primary feature alone, since an alternative is a gazetteer place rather than the row", () => {
		const collection = photonForwardCollection(
			{
				primary: { ...THAMES, coordinateSource: { source: "openstreetmap:nz", release: "2026-08-06" } },
				alternatives: [{ lat: -37.14, lon: 175.54, places: [{ tag: "locality", name: "Thames" }] }],
			},
			5
		)

		expect(collection.features.map((f) => f.properties.mailwoman?.coordinate_source.source)).toEqual([
			"openstreetmap:nz",
			undefined,
		])
	})
})
