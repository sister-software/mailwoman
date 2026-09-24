/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Policy types for selecting rule and neural proposals by component and locale.
 */

import type { ComponentTag } from "@mailwoman/codex/component"

import type { ClassificationProposal } from "#types"

/**
 * Which classifier proposals to retain for a component.
 */
export type PolicyMode = "rule_only" | "neural_only" | "both" | "neural_preferred" | "rule_preferred"

/**
 * Policy for one component, optionally scoped to a locale.
 */
export interface ClassifierPolicy {
	component: ComponentTag
	mode: PolicyMode

	/**
	 * Inclusive minimum confidence applied before mode filtering.
	 */
	confidence_threshold?: number

	/**
	 * Locale this entry applies to.
	 * Unset entries are global defaults.
	 */
	locale?: string
}

/**
 * Read-only policy lookup and filtering interface.
 */
export interface PolicyRegistry {
	/**
	 * Return the locale-specific policy, global policy, or default policy for a component.
	 */
	lookup(component: ComponentTag, locale?: string): ClassifierPolicy

	/**
	 * Return filtered proposals without mutating the input.
	 */
	apply(proposals: readonly ClassificationProposal[], locale?: string): ClassificationProposal[]
}
