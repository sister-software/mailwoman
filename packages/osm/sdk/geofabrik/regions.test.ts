/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Every country extraction policy lists Geofabrik regions this registry lists, and each of them holds
 *   the country, so a policy never points at a region by a URL or an identity the acquisition cannot resolve.
 */

import { describe, expect, it } from "vitest"

import { extractionPolicyCountries, extractionPolicyFor } from "#extraction-policy"
import { geofabrikExtractURL, geofabrikRegion, geofabrikRegionsHolding } from "#sdk/geofabrik/regions"

describe("the Geofabrik region registry and the country policies", () => {
	it.each(extractionPolicyCountries())("%s's policy names listed regions that hold it", (country) => {
		const policy = extractionPolicyFor(country)!

		const problems = policy.regions.flatMap((id) => {
			const region = geofabrikRegion(id)

			if (!region) return [`${id} is not listed`]

			return region.countries.includes(country) ? [] : [`${id} does not hold ${country}`]
		})

		expect(problems).toEqual([])

		expect(geofabrikRegionsHolding(country).map((region) => region.id)).toEqual(
			expect.arrayContaining([...policy.regions])
		)
	})

	it("composes the latest-extract URL under a base URL", () => {
		const region = geofabrikRegion("/europe/dach/")!

		expect(geofabrikExtractURL(region)).toBe("https://download.geofabrik.de/europe/dach-latest.osm.pbf")

		expect(geofabrikExtractURL(region, "http://mirror.example/osm")).toBe(
			"http://mirror.example/osm/europe/dach-latest.osm.pbf"
		)
	})
})
