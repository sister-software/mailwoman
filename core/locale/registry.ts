/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   In-memory `LocaleRegistry`. Validates that every `LocaleProfile.componentsSupported` entry is a
 *   known `ComponentTag`, and that each policy override targets a component inside
 *   `componentsSupported`. Fails loudly at registration when either invariant is broken (#6
 *   §LocaleProfile validation rule).
 */

import { COMPONENT_TAGS, type ComponentTag } from "@mailwoman/core/types"
import type { LocaleProfile, LocaleRegistry } from "./locale.js"

const COMPONENT_TAG_SET = new Set<ComponentTag>(COMPONENT_TAGS)

export class InMemoryLocaleRegistry implements LocaleRegistry {
	#profiles = new Map<string, LocaleProfile>()

	register(profile: LocaleProfile): void {
		assertValidProfile(profile)
		this.#profiles.set(profile.locale, profile)
	}

	get(locale: string): LocaleProfile | undefined {
		return this.#profiles.get(locale)
	}

	list(): LocaleProfile[] {
		return Array.from(this.#profiles.values())
	}

	/** Remove a locale. No-op if not present. */
	unregister(locale: string): void {
		this.#profiles.delete(locale)
	}
}

function assertValidProfile(profile: LocaleProfile): void {
	if (!profile.locale) {
		throw new TypeError("LocaleProfile.locale must be a non-empty BCP-47 tag")
	}

	const supported = new Set<ComponentTag>(profile.componentsSupported)
	for (const tag of supported) {
		if (!COMPONENT_TAG_SET.has(tag)) {
			throw new RangeError(
				`LocaleProfile ${profile.locale}: componentsSupported contains unknown ComponentTag ${JSON.stringify(tag)}`
			)
		}
	}

	for (const policy of profile.policy) {
		if (!COMPONENT_TAG_SET.has(policy.component)) {
			throw new RangeError(
				`LocaleProfile ${profile.locale}: policy targets unknown ComponentTag ${JSON.stringify(policy.component)}`
			)
		}
		if (!supported.has(policy.component)) {
			throw new RangeError(
				`LocaleProfile ${profile.locale}: policy targets ${policy.component} which is not in componentsSupported`
			)
		}
	}
}
