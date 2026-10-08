/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The lockstep pin: dev-mcp's effective defaults are production's, field by field.
 */

import { createGeocodeCommandOptions, GEOCODE_SWITCH_DEFAULTS } from "mailwoman/geocode"
import { describe, expect, it } from "vitest"

import { resolveConfig } from "#dev-mcp/engine/registry"

describe("resolveConfig — production lockstep (#1732)", () => {
	it("matches the geocode command's own defaults on every shared pin", () => {
		const production = createGeocodeCommandOptions()
		const resolved = resolveConfig({})

		expect(resolved.locale).toBe(production.locale)
		expect(resolved.countryScope).toBe(production.countryScope)
		expect(resolved.localeCountryPrior).toBe(production.localeCountryPrior)
		expect(resolved.placeCountry).toBe(production.placeCountry)
		expect(resolved.postcodeCountryCoherence).toBe(production.postcodeCountryCoherence)
		expect(resolved.forkEntity).toBe(production.forkEntity)
		expect(resolved.postcodeShapeCoherence).toBe(production.postcodeShapeCoherence)
		expect(resolved.postcodeContainmentCoherence).toBe(production.postcodeContainmentCoherence)
		expect(resolved.placeCountryThreshold).toBe(production.placeCountryThreshold)
		expect(resolved.gazetteerPrior).toBe(production.gazetteerPrior)
		expect(resolved.adminContainmentRerank).toBe(production.adminContainmentRerank)
	})

	it("names the three drifted values so the incident stays legible", () => {
		const resolved = resolveConfig({})

		expect(resolved.postcodeShapeCoherence).toBe(false)
		expect(resolved.postcodeContainmentCoherence).toBe(false)
		expect(resolved.placeCountryThreshold).toBe(0.9)
	})

	it("still lets every pin override the production default", () => {
		const resolved = resolveConfig({
			postcode_shape_coherence: true,
			place_country_threshold: 0.5,
			admin_containment_rerank: false,
		})

		expect(resolved.postcodeShapeCoherence).toBe(true)
		expect(resolved.placeCountryThreshold).toBe(0.5)
		expect(resolved.adminContainmentRerank).toBe(false)
	})

	it("resolves variant_alias_exemption from either named value or the production default", () => {
		expect(resolveConfig({}).variantAliasExemption).toBe(createGeocodeCommandOptions().variantAliasExemption)
		expect(resolveConfig({ variant_alias_exemption: "applied" }).variantAliasExemption).toBe(true)
		expect(resolveConfig({ variant_alias_exemption: "not_applied" }).variantAliasExemption).toBe(false)
	})

	it("resolves poi_venue_tier to an explicit value in both directions", () => {
		expect(resolveConfig({}).poiVenueTier).toBe(GEOCODE_SWITCH_DEFAULTS.poiVenueTier)
		expect(resolveConfig({ poi_venue_tier: true }).poiVenueTier).toBe(true)
		expect(resolveConfig({ poi_venue_tier: false }).poiVenueTier).toBe(false)
	})
})
