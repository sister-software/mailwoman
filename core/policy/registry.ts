/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   In-memory `PolicyRegistry`. Stores per-(component, locale) policy entries and applies them to a
 *   flat list of `ClassificationProposal`s.
 *
 *   Mutation API (`set`, `remove`) lives here so that locale profiles (#6 §LocaleProfile) can install
 *   per-locale overrides at startup. Look-up and `apply` are pure.
 */

import type { ClassificationProposal, ComponentTag } from "@mailwoman/core/types"
import { buildDefaultPolicies, defaultPolicyFor } from "./defaults.js"
import type { ClassifierPolicy, PolicyMode, PolicyRegistry } from "./policy.js"

const GLOBAL_LOCALE_KEY = "*"

function policyKey(component: ComponentTag, locale: string | undefined): string {
	return `${component}::${locale ?? GLOBAL_LOCALE_KEY}`
}

/**
 * Concrete registry implementation. Construct empty with `new InMemoryPolicyRegistry()` and load
 * entries via `set()`, or pre-load defaults via `InMemoryPolicyRegistry.withDefaults()`.
 */
export class InMemoryPolicyRegistry implements PolicyRegistry {
	#entries = new Map<string, ClassifierPolicy>()

	/** Build a registry pre-loaded with `rule_only` for every component. */
	static withDefaults(): InMemoryPolicyRegistry {
		const registry = new InMemoryPolicyRegistry()
		for (const policy of buildDefaultPolicies()) {
			registry.set(policy)
		}
		return registry
	}

	/** Install a policy entry. Replaces any prior entry with the same key. */
	set(policy: ClassifierPolicy): void {
		this.#entries.set(policyKey(policy.component, policy.locale), policy)
	}

	/** Remove a policy entry, if present. */
	remove(component: ComponentTag, locale?: string): void {
		this.#entries.delete(policyKey(component, locale))
	}

	/** All current entries, in insertion order. */
	entries(): ClassifierPolicy[] {
		return Array.from(this.#entries.values())
	}

	lookup(component: ComponentTag, locale?: string): ClassifierPolicy {
		if (locale) {
			const localized = this.#entries.get(policyKey(component, locale))
			if (localized) return localized
		}
		const global = this.#entries.get(policyKey(component, undefined))
		if (global) return global
		return defaultPolicyFor(component)
	}

	apply(proposals: readonly ClassificationProposal[], locale?: string): ClassificationProposal[] {
		const passedThreshold: ClassificationProposal[] = []
		const policyByComponent = new Map<ComponentTag, ClassifierPolicy>()

		for (const proposal of proposals) {
			const policy = policyByComponent.get(proposal.component) ?? this.lookup(proposal.component, locale)
			policyByComponent.set(proposal.component, policy)

			if (typeof policy.confidence_threshold === "number" && proposal.confidence < policy.confidence_threshold) {
				continue
			}
			if (!matchesMode(proposal, policy.mode)) continue

			passedThreshold.push(proposal)
		}

		return applyPreferenceFilters(passedThreshold, policyByComponent)
	}
}

function matchesMode(proposal: ClassificationProposal, mode: PolicyMode): boolean {
	switch (mode) {
		case "rule_only":
			return proposal.source === "rule"
		case "neural_only":
			return proposal.source === "neural"
		case "both":
		case "rule_preferred":
		case "neural_preferred":
			return proposal.source === "rule" || proposal.source === "neural" || proposal.source === "merged"
	}
}

/**
 * Second pass for `rule_preferred` / `neural_preferred`: within each component, drop the
 * dispreferred source when the preferred source has at least one survivor.
 */
function applyPreferenceFilters(
	proposals: readonly ClassificationProposal[],
	policyByComponent: ReadonlyMap<ComponentTag, ClassifierPolicy>
): ClassificationProposal[] {
	const grouped = new Map<ComponentTag, ClassificationProposal[]>()
	for (const proposal of proposals) {
		const list = grouped.get(proposal.component) ?? []
		list.push(proposal)
		grouped.set(proposal.component, list)
	}

	const out: ClassificationProposal[] = []
	for (const [component, list] of grouped) {
		const policy = policyByComponent.get(component)
		if (!policy) {
			out.push(...list)
			continue
		}

		if (policy.mode === "neural_preferred") {
			const hasNeural = list.some((p) => p.source === "neural")
			out.push(...(hasNeural ? list.filter((p) => p.source !== "rule") : list))
			continue
		}
		if (policy.mode === "rule_preferred") {
			const hasRule = list.some((p) => p.source === "rule")
			out.push(...(hasRule ? list.filter((p) => p.source !== "neural") : list))
			continue
		}

		out.push(...list)
	}

	return out
}
