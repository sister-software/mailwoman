/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Default policy table: every component is `rule_only` until per-tag golden-set metrics justify a
 *   migration. This file is the canonical place to record such migrations; each Phase 2+ rollout
 *   edits one entry here with a commit-message rationale.
 */

import { COMPONENT_TAGS, type ComponentTag } from "@mailwoman/core/types"

import type { ClassifierPolicy, PolicyMode } from "./policy.ts"

/**
 * Build a fresh array of policies — one per `ComponentTag`, all in `mode`. Returns a new array on each call; callers
 * may mutate it freely.
 *
 * `mode` defaults to `rule_only` (the historical default — every component rule-sourced until a per-tag migration). The
 * input-shape router (#478 increment 2) passes a shape-derived default (e.g. `neural_preferred` for OOD-script input)
 * so the whole table starts from the routed prior before per-tag config overlays.
 */
export function buildDefaultPolicies(mode: PolicyMode = "rule_only"): ClassifierPolicy[] {
	return COMPONENT_TAGS.map<ClassifierPolicy>((component) => ({
		component,
		mode,
	}))
}

/**
 * Convenience accessor for a single-component default. `mode` defaults to `rule_only`.
 */
export function defaultPolicyFor(component: ComponentTag, mode: PolicyMode = "rule_only"): ClassifierPolicy {
	return { component, mode }
}
