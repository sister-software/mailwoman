/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Forward-compat check that the core abstraction handles a locale that omits `street` and adds
 *   JP-specific tags (`prefecture`, `municipality`, …) without throwing and without type assertions.
 */

import { COMPONENT_TAGS, type ComponentTag } from "@mailwoman/codex/component"
import { enUS, frFR, InMemoryLocaleRegistry, jaJP, type LocaleProfile } from "@mailwoman/core/locale"
import { InMemoryPolicyRegistry } from "@mailwoman/core/policy"
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
				.toSorted()
		).toEqual(["en-US", "fr-FR", "ja-JP"])
	})

	test("PolicyRegistry can install neural_only defaults for JP-only tags without throwing", () => {
		const policy = InMemoryPolicyRegistry.withDefaults()

		for (const tag of jaJP.componentsSupported) {
			const entry = policy.lookup(tag)
			expect(entry.mode).toBe("neural_only")
			expect(entry.component).toBe(tag)
		}
	})

	test("PolicyRegistry honors a ja-JP-scoped policy override for a JP-specific tag", () => {
		const policy = InMemoryPolicyRegistry.withDefaults()
		policy.set({ component: "prefecture", mode: "both", locale: "ja-JP" })

		expect(policy.lookup("prefecture", "ja-JP").mode).toBe("both")
		// The global default stays neural_only.
		expect(policy.lookup("prefecture").mode).toBe("neural_only")
		// The en-US locale does not inherit the JP override.
		expect(policy.lookup("prefecture", "en-US").mode).toBe("neural_only")
	})

	test("LocaleRegistry rejects a fake JP profile that references an undeclared tag", () => {
		const registry = new InMemoryLocaleRegistry()

		const malformed: LocaleProfile = {
			locale: "ja-JP-bad",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			componentsSupported: [...jaJP.componentsSupported, "not_a_tag" as any],
			policy: [],
		}

		expect(() => registry.register(malformed)).toThrow(/unknown ComponentTag/)
	})
})
