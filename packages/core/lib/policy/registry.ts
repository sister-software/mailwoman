/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   In-memory `PolicyRegistry`. Stores per-(component, locale) policy entries and applies them to a
 *   flat list of `ClassificationProposal`s.
 *
 *   The mutation API (`set`, `remove`) lives here so that locale profiles can install per-locale
 *   overrides at startup. Look-up and `apply` are pure.
 */

import type { ComponentTag } from "@mailwoman/codex/component"

import { buildDefaultPolicies, defaultPolicyFor } from "#policy/defaults"
import type { ClassifierPolicy, PolicyMode, PolicyRegistry } from "#policy/policy"
import type { ClassificationProposal } from "#types"

const GLOBAL_LOCALE_KEY = "*"

function policyKey(component: ComponentTag, locale: string | null | undefined): string {
	return `${component}::${locale ?? GLOBAL_LOCALE_KEY}`
}

/**
 * Concrete registry implementation.
 *
 * Construct empty with `new InMemoryPolicyRegistry()` and load entries via `set()`,
 * or pre-load defaults via `InMemoryPolicyRegistry.withDefaults()`.
 */
export class InMemoryPolicyRegistry implements PolicyRegistry {
	#entries = new Map<string, ClassifierPolicy>()

	/**
	 * Build a registry pre-loaded with `mode` for every component (default `neural_only`).
	 *
	 * The input-shape router passes a shape-derived default so the whole table starts from the routed prior.
	 */
	static withDefaults(mode: PolicyMode = "neural_only"): InMemoryPolicyRegistry {
		const registry = new InMemoryPolicyRegistry()

		for (const policy of buildDefaultPolicies(mode)) {
			registry.set(policy)
		}

		return registry
	}

	/**
	 * Install a policy entry.
	 *
	 * Replaces any prior entry with the same key.
	 */
	set(policy: ClassifierPolicy): void {
		this.#entries.set(policyKey(policy.component, policy.locale), policy)
	}

	/**
	 * Remove a policy entry, if present.
	 */
	remove(component: ComponentTag, locale?: string): void {
		this.#entries.delete(policyKey(component, locale))
	}

	/**
	 * All current entries, in insertion order.
	 */
	entries(): ClassifierPolicy[] {
		return Array.from(this.#entries.values())
	}

	lookup(component: ComponentTag, locale?: string): ClassifierPolicy {
		if (locale) {
			const localized = this.#entries.get(policyKey(component, locale))

			if (localized) return localized
		}

		const global = this.#entries.get(policyKey(component, null))

		if (global) return global

		return defaultPolicyFor(component)
	}

	apply(proposals: readonly ClassificationProposal[], locale?: string): ClassificationProposal[] {
		const retained: ClassificationProposal[] = []
		const policyByComponent = new Map<ComponentTag, ClassifierPolicy>()

		for (const proposal of proposals) {
			const policy = policyByComponent.get(proposal.component) ?? this.lookup(proposal.component, locale)
			policyByComponent.set(proposal.component, policy)

			if (typeof policy.confidence_threshold === "number" && proposal.confidence < policy.confidence_threshold) {
				continue
			}

			if (!matchesMode(proposal, policy.mode)) continue

			retained.push(proposal)
		}

		return retained
	}
}

/**
 * Decide whether a proposal's source is admitted under a mode.
 */
function matchesMode(proposal: ClassificationProposal, mode: PolicyMode): boolean {
	switch (mode) {
		case "neural_only":
			return proposal.source === "neural"
		case "both":
			return true
	}
}
