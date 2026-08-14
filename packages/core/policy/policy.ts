/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Classifier policy types (per #6). A `ClassifierPolicy` declares which classifier family (rule /
 *   neural / both / preferred) has authority for each `ComponentTag`, optionally narrowed by
 *   locale. The default table starts every component in `rule_only` mode; migrations to
 *   neural-backed modes happen one component at a time, gated on golden-set metrics.
 */

import type { ClassificationProposal, ComponentTag } from "@mailwoman/core/types"

/**
 * How a component is sourced.
 *
 * - `rule_only`: keep only `source === "rule"` proposals (default).
 * - `neural_only`: keep only `source === "neural"` proposals.
 * - `both`: keep proposals from any source.
 * - `neural_preferred`: keep all proposals, but drop rule proposals when at least one neural proposal exists for the same
 *   component.
 * - `rule_preferred`: mirror of `neural_preferred`, with rule winning.
 */
export type PolicyMode = "rule_only" | "neural_only" | "both" | "neural_preferred" | "rule_preferred"

/**
 * A single policy entry. Locale-less entries are the global default; locale-scoped entries override the global default
 * for that locale.
 */
export interface ClassifierPolicy {
	component: ComponentTag
	mode: PolicyMode

	/**
	 * Minimum confidence for a proposal to be retained. Applied before the policy-mode filter. Inclusive ([threshold,
	 * 1.0]). Undefined means "no threshold."
	 */
	confidence_threshold?: number

	/**
	 * Locale scope. If absent, the entry applies to every locale unless overridden by a locale-specific entry.
	 */
	locale?: string
}

/**
 * Read-side view of the policy table.
 */
export interface PolicyRegistry {
	/**
	 * Look up the effective policy for a (component, locale) pair. A locale-specific entry wins over a global one; if
	 * neither exists, the registry-wide default (`rule_only`, no threshold) is returned.
	 */
	lookup(component: ComponentTag, locale?: string): ClassifierPolicy

	/**
	 * Apply policy filtering to a flat list of proposals. Output is a new array; the input is not mutated.
	 */
	apply(proposals: readonly ClassificationProposal[], locale?: string): ClassificationProposal[]
}
