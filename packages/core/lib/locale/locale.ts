/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Locale-profile types. A `LocaleProfile` declares everything locale-specific about
 *   classification: which weights package (if any) backs the neural classifier, which
 *   `ComponentTag`s the locale uses, and any per-component policy overrides.
 *
 *   A profile is keyed by its `locale` field, and `InMemoryLocaleRegistry.get` returns it for that
 *   exact BCP-47 tag.
 */

import type { ComponentTag } from "@mailwoman/codex/component"

import type { ClassifierPolicy } from "#policy/policy"

export interface LocaleProfile {
	/**
	 * BCP-47 locale tag (e.g. `"en-US"`, `"fr-FR"`, `"ja-JP"`).
	 */
	locale: string

	/**
	 * Npm package providing ONNX weights and tokenizer for the neural classifier in this locale.
	 *
	 * A locale without a weights package has no classifier of its own.
	 */
	weightsPackage?: string

	/**
	 * Components this locale uses.
	 *
	 * Must be a subset of `COMPONENT_TAGS`.
	 * The system validates this at registration.
	 */
	componentsSupported: ComponentTag[]

	/**
	 * Per-component policy overrides for this locale.
	 */
	policy: ClassifierPolicy[]
}

export interface LocaleRegistry {
	register(profile: LocaleProfile): void
	get(locale: string): LocaleProfile | undefined
	list(): LocaleProfile[]
}
