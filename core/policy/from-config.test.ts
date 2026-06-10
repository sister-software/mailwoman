/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The loud-validation contract for policy-config loading (#478). Every rejection path throws
 *   with the offending JSON path — a config typo must never silently fall back to defaults.
 */

import { describe, expect, it } from "vitest"

import { policyRegistryFromConfig } from "./from-config.js"

describe("policyRegistryFromConfig", () => {
	it("loads locale-scoped and global entries over the defaults", () => {
		const registry = policyRegistryFromConfig({
			"en-US": { region: { mode: "neural_preferred", confidence_threshold: 0.6 } },
			"*": { country: { mode: "both" } },
		})
		expect(registry.lookup("region", "en-US").mode).toBe("neural_preferred")
		expect(registry.lookup("region", "en-US").confidence_threshold).toBe(0.6)
		expect(registry.lookup("region", "fr-FR").mode).toBe("rule_only") // untouched default
		expect(registry.lookup("country", "fr-FR").mode).toBe("both") // global applies everywhere
		expect(registry.lookup("street", "en-US").mode).toBe("rule_only") // absent tag = today's behavior
	})

	it("throws on an unknown tag, naming the path", () => {
		expect(() => policyRegistryFromConfig({ "en-US": { streets: { mode: "both" } } })).toThrow(
			/"en-US"\."streets" is not a ComponentTag/,
		)
	})

	it("throws on an unknown mode", () => {
		expect(() =>
			policyRegistryFromConfig({ "*": { region: { mode: "neural" as never } } }),
		).toThrow(/mode "neural" is not one of/)
	})

	it("throws on an unknown field (the minimumConfidence lesson)", () => {
		expect(() =>
			policyRegistryFromConfig({
				"*": { region: { mode: "both", minimumConfidence: 0.8 } as never },
			}),
		).toThrow(/"minimumConfidence" is not a recognized field/)
	})

	it("throws on an out-of-range threshold", () => {
		expect(() =>
			policyRegistryFromConfig({ "*": { region: { mode: "both", confidence_threshold: 1.5 } } }),
		).toThrow(/must be a number in \[0, 1\]/)
	})

	it("throws on malformed shapes rather than guessing", () => {
		expect(() => policyRegistryFromConfig([] as never)).toThrow(/root must be an object/)
		expect(() => policyRegistryFromConfig({ "en-US": "neural_preferred" as never })).toThrow(
			/"en-US" must be an object/,
		)
		expect(() => policyRegistryFromConfig({ "*": { region: "both" as never } })).toThrow(
			/must be an object with a "mode" field/,
		)
	})
})
