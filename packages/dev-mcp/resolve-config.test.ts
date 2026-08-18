/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The lockstep pin for #1732: dev-mcp's effective defaults ARE production's, field by field.
 *
 *   The incident this guards: `resolveConfig` carried a hand-copied default table that drifted on three values
 *   (postcode shape/containment coherence true where production ships false; placer threshold 0.5 where production
 *   ships 0.9), so every unset-lever measurement graded a configuration nobody ships. A copied constant cannot be kept
 *   honest by review — the #861 rule — so `resolveConfig` now derives from `createGeocodeCommandOptions()` itself, and
 *   this test exists to fail if anyone re-introduces a literal.
 */

import { createGeocodeCommandOptions } from "mailwoman/geocode-command-options"
import { describe, expect, it } from "vitest"

import { resolveConfig } from "./engine-registry.ts"

describe("resolveConfig — production lockstep (#1732)", () => {
	it("matches the geocode command's own defaults on every shared lever", () => {
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
		// These are assertions about PRODUCTION, mirrored here on purpose: if the shipped defaults change, this test
		// fails and the person changing them is told the board's baselines need re-anchoring — which is the actual
		// consequence of moving a default, and the thing the silent drift skipped.
		const resolved = resolveConfig({})

		expect(resolved.postcodeShapeCoherence).toBe(false)
		expect(resolved.postcodeContainmentCoherence).toBe(false)
		expect(resolved.placeCountryThreshold).toBe(0.9)
	})

	it("still lets every lever override the production default", () => {
		const resolved = resolveConfig({
			postcode_shape_coherence: true,
			place_country_threshold: 0.5,
			admin_containment_rerank: false,
		})

		expect(resolved.postcodeShapeCoherence).toBe(true)
		expect(resolved.placeCountryThreshold).toBe(0.5)
		expect(resolved.adminContainmentRerank).toBe(false)
	})
})
