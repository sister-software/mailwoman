// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { enUS, frFR, jaJP } from "#locale/profiles"
import { InMemoryLocaleRegistry } from "#locale/registry"

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
				.toSorted()
		).toEqual(["en-US", "fr-FR"])
	})

	test("get returns undefined for unknown locale", () => {
		const registry = new InMemoryLocaleRegistry()
		expect(registry.get("zh-CN")).toBeNull()
	})

	test("re-registering the same locale replaces the prior entry", () => {
		const registry = new InMemoryLocaleRegistry()
		registry.register(enUS)
		const altered = { ...enUS, weightsPackage: "@mailwoman/neural-weights-overridden" }
		registry.register(altered)
		expect(registry.get("en-US")).toBe(altered)
	})

	test("unregister removes the entry", () => {
		const registry = new InMemoryLocaleRegistry()
		registry.register(enUS)
		registry.unregister("en-US")
		expect(registry.get("en-US")).toBeNull()
	})
})

describe("InMemoryLocaleRegistry — validation", () => {
	test("rejects an unknown ComponentTag in componentsSupported", () => {
		const registry = new InMemoryLocaleRegistry()

		expect(() =>
			registry.register({
				locale: "xx-XX",
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
				componentsSupported: ["country"],
				policy: [{ component: "postcode", mode: "neural_only" }],
			})
		).toThrow(/not in componentsSupported/)
	})
})

describe("LocaleProfile — bundled profiles", () => {
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
		expect(registry.list()).toHaveLength(3)
	})
})
