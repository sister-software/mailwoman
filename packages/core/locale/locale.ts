/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Locale-profile types (per #6 §LocaleProfile). A `LocaleProfile` declares everything
 *   locale-specific about classification: which weights package (if any) backs the neural
 *   classifier, which rule classifier IDs are active, which `ComponentTag`s the locale actually
 *   uses, and any per-component policy overrides.
 *
 *   The classifier IDs in `ruleClassifiers` are the stable `ProposalClassifier.id` values that
 *   `wrapLegacyClassifier` assigns when the legacy classifier registry lands (see the Phase 0
 *   task-3 follow-up in DECISIONS.md).
 */

import type { ComponentTag } from "@mailwoman/core/types"
import type { ClassifierPolicy } from "../policy/policy.js"

export interface LocaleProfile {
	/** BCP-47 locale tag (e.g. `"en-US"`, `"fr-FR"`, `"ja-JP"`). */
	locale: string

	/**
	 * Npm package providing ONNX weights and tokenizer for the neural classifier in this locale.
	 * Optional — Phase 0 ships no weights; a locale without a weights package runs rule-only.
	 */
	weightsPackage?: string

	/**
	 * Rule classifier IDs active in this locale. Stable identifiers declared by
	 * `ProposalClassifier.id`. An empty list means the locale relies entirely on neural inference.
	 */
	ruleClassifiers: string[]

	/**
	 * Components this locale uses. Must be a subset of `COMPONENT_TAGS`. The system validates this at
	 * registration.
	 */
	componentsSupported: ComponentTag[]

	/** Per-component policy overrides for this locale. */
	policy: ClassifierPolicy[]
}

export interface LocaleRegistry {
	register(profile: LocaleProfile): void
	get(locale: string): LocaleProfile | undefined
	list(): LocaleProfile[]
}
