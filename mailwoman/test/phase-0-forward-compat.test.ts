/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phase 0 §8 forward-compat sanity check (per #8). Verifies that the core abstraction handles a
 *   locale that omits `street` and `house_number` and adds JP-specific tags (`prefecture`,
 *   `municipality`, …) without throwing, without type assertions, and without an empty
 *   `ruleClassifiers` list tripping any registry.
 *
 *   If this test ever breaks, the abstraction is wrong — fix it now, not in Phase 6.
 */

import { enUS, frFR, InMemoryLocaleRegistry, jaJP, type LocaleProfile } from "@mailwoman/core/locale"
import { InMemoryPolicyRegistry } from "@mailwoman/core/policy"
import { COMPONENT_TAGS, type ComponentTag } from "@mailwoman/core/types"
import { describe, expect, test } from "vitest"

describe("Phase 0 §8 — JP forward-compat", () => {
	test("every ja-JP component is a declared ComponentTag (no schema gap)", () => {
		const tagSet = new Set<ComponentTag>(COMPONENT_TAGS)
		for (const tag of jaJP.componentsSupported) {
			expect(tagSet.has(tag), `ja-JP componentsSupported contains unknown tag: ${tag}`).toBe(true)
		}
	})

	test("LocaleRegistry accepts ja-JP, en-US, and fr-FR in the same registry", () => {
		const registry = new InMemoryLocaleRegistry()
		expect(() => registry.register(enUS)).not.toThrow()
		expect(() => registry.register(frFR)).not.toThrow()
		expect(() => registry.register(jaJP)).not.toThrow()
		expect(
			registry
				.list()
				.map((p) => p.locale)
				.sort()
		).toEqual(["en-US", "fr-FR", "ja-JP"])
	})

	test("ja-JP defines no rule classifiers (neural-only locale is expressible)", () => {
		expect(jaJP.ruleClassifiers.length).toBe(0)
	})

	test("PolicyRegistry can install rule_only defaults for JP-only tags without throwing", () => {
		const policy = InMemoryPolicyRegistry.withDefaults()
		for (const tag of jaJP.componentsSupported) {
			const entry = policy.lookup(tag)
			expect(entry.mode).toBe("rule_only")
			expect(entry.component).toBe(tag)
		}
	})

	test("PolicyRegistry honors a ja-JP-scoped policy override for a JP-specific tag", () => {
		const policy = InMemoryPolicyRegistry.withDefaults()
		policy.set({ component: "prefecture", mode: "neural_only", locale: "ja-JP" })

		expect(policy.lookup("prefecture", "ja-JP").mode).toBe("neural_only")
		// Global default still rule_only.
		expect(policy.lookup("prefecture").mode).toBe("rule_only")
		// en-US locale doesn't inherit the JP override.
		expect(policy.lookup("prefecture", "en-US").mode).toBe("rule_only")
	})

	test("LocaleRegistry rejects a fake JP profile that references an undeclared tag", () => {
		const registry = new InMemoryLocaleRegistry()
		const malformed: LocaleProfile = {
			locale: "ja-JP-bad",
			ruleClassifiers: [],
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			componentsSupported: [...jaJP.componentsSupported, "not_a_tag" as any],
			policy: [],
		}
		expect(() => registry.register(malformed)).toThrow(/unknown ComponentTag/)
	})
})
