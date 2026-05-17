// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Default policy table: every component is `rule_only` until per-tag golden-set metrics justify a
 *   migration. This file is the canonical place to record such migrations; each Phase 2+ rollout
 *   edits one entry here with a commit-message rationale.
 */

import { COMPONENT_TAGS, type ComponentTag } from "@mailwoman/core/types"
import type { ClassifierPolicy } from "./policy.js"

/**
 * Build a fresh array of `rule_only` policies — one per `ComponentTag`. Returns a new array on each
 * call; callers may mutate it freely.
 */
export function buildDefaultPolicies(): ClassifierPolicy[] {
	return COMPONENT_TAGS.map<ClassifierPolicy>((component) => ({
		component,
		mode: "rule_only",
	}))
}

/**
 * Convenience accessor for a single-component default.
 */
export function defaultPolicyFor(component: ComponentTag): ClassifierPolicy {
	return { component, mode: "rule_only" }
}
