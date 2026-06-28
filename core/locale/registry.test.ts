/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { enUS, frFR, jaJP } from "./profiles/index.js"
import { InMemoryLocaleRegistry } from "./registry.js"

describe("InMemoryLocaleRegistry — registration", () => {
	test("register / get / list round-trip", () => {
		const registry = new InMemoryLocaleRegistry()
		registry.register(enUS)
		registry.register(frFR)

		expect(registry.get("en-US")).toBe(enUS)
		expect(registry.get("fr-FR")).toBe(frFR)
		expect(
			registry
				.list()
				.map((p) => p.locale)
				.sort()
		).toEqual(["en-US", "fr-FR"])
	})

	test("get returns undefined for unknown locale", () => {
		const registry = new InMemoryLocaleRegistry()
		expect(registry.get("zh-CN")).toBeUndefined()
	})

	test("re-registering the same locale replaces the prior entry", () => {
		const registry = new InMemoryLocaleRegistry()
		registry.register(enUS)
		const altered = { ...enUS, ruleClassifiers: ["overridden"] }
		registry.register(altered)
		expect(registry.get("en-US")).toBe(altered)
	})

	test("unregister removes the entry", () => {
		const registry = new InMemoryLocaleRegistry()
		registry.register(enUS)
		registry.unregister("en-US")
		expect(registry.get("en-US")).toBeUndefined()
	})
})

describe("InMemoryLocaleRegistry — validation", () => {
	test("rejects an unknown ComponentTag in componentsSupported", () => {
		const registry = new InMemoryLocaleRegistry()
		expect(() =>
			registry.register({
				locale: "xx-XX",
				ruleClassifiers: [],
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				componentsSupported: ["country", "not_a_real_tag" as any],
				policy: [],
			})
		).toThrow(/unknown ComponentTag/)
	})

	test("rejects an empty locale tag", () => {
		const registry = new InMemoryLocaleRegistry()
		expect(() =>
			registry.register({
				locale: "",
				ruleClassifiers: [],
				componentsSupported: [],
				policy: [],
			})
		).toThrow(/non-empty/)
	})

	test("rejects a policy override outside componentsSupported", () => {
		const registry = new InMemoryLocaleRegistry()
		expect(() =>
			registry.register({
				locale: "en-US",
				ruleClassifiers: [],
				componentsSupported: ["country"],
				policy: [{ component: "postcode", mode: "neural_only" }],
			})
		).toThrow(/not in componentsSupported/)
	})
})

describe("LocaleProfile — bundled profiles", () => {
	test("en-US covers the v1 Anglophone tag set", () => {
		const expected = [
			"country",
			"region",
			"locality",
			"postcode",
			"house_number",
			"street",
			"street_prefix",
			"street_suffix",
			"unit",
			"venue",
			"attention",
			"po_box",
			"intersection_a",
			"intersection_b",
		]

		for (const tag of expected) {
			expect(enUS.componentsSupported).toContain(tag)
		}
		expect(enUS.ruleClassifiers.length).toBeGreaterThan(0)
	})

	test("fr-FR adds cedex, dependent_locality, street_prefix_particle", () => {
		expect(frFR.componentsSupported).toContain("cedex")
		expect(frFR.componentsSupported).toContain("dependent_locality")
		expect(frFR.componentsSupported).toContain("street_prefix_particle")
	})

	test("ja-JP omits street and house_number (Phase 6 forward-compat)", () => {
		expect(jaJP.componentsSupported).not.toContain("street")
		expect(jaJP.componentsSupported).not.toContain("house_number")
		expect(jaJP.componentsSupported).toContain("prefecture")
		expect(jaJP.componentsSupported).toContain("municipality")
	})

	test("ja-JP registers without throwing", () => {
		const registry = new InMemoryLocaleRegistry()
		expect(() => registry.register(jaJP)).not.toThrow()
		expect(registry.get("ja-JP")).toBe(jaJP)
	})

	test("registry can hold en-US, fr-FR, and ja-JP simultaneously", () => {
		const registry = new InMemoryLocaleRegistry()
		registry.register(enUS)
		registry.register(frFR)
		registry.register(jaJP)
		expect(registry.list().length).toBe(3)
	})
})
