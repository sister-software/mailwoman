/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Default policy table: every component starts at `neural_only`, and a per-component change is
 *   recorded here with its rationale in the commit message.
 */

import { COMPONENT_TAGS, type ComponentTag } from "@mailwoman/codex/component"

import type { ClassifierPolicy, PolicyMode } from "#policy/policy"

/**
 * Build a fresh array of policies, one per `ComponentTag`, all in `mode`.
 *
 * Returns a new array on each call.
 * Callers may mutate it freely.
 *
 * `mode` defaults to `neural_only`.
 * The input-shape router passes a shape-derived default, so the table starts from the routed prior.
 */
export function buildDefaultPolicies(mode: PolicyMode = "neural_only"): ClassifierPolicy[] {
	return COMPONENT_TAGS.map<ClassifierPolicy>((component) => ({
		component,
		mode,
	}))
}

/**
 * Convenience accessor for a single-component default.
 *
 * `mode` defaults to `neural_only`.
 */
export function defaultPolicyFor(component: ComponentTag, mode: PolicyMode = "neural_only"): ClassifierPolicy {
	return { component, mode }
}
