/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Config-file loading for the policy registry (#478 step 1). Rolling a component from rules to
 *   neural previously required code edits + a release; this lets an operator (or the arbitration
 *   layer's shape overlays, #478 step 2) declare per-locale per-tag policy as data:
 *
 *   ```jsonc
 *   // mailwoman.policies.json
 *   {
 *     "en-US": {
 *       "region":   { "mode": "neural_preferred", "confidence_threshold": 0.6 },
 *       "street":   { "mode": "rule_preferred" }
 *     },
 *     "*": {                       // global (locale-less) entries
 *       "country":  { "mode": "both" }
 *     }
 *   }
 *   ```
 *
 *   Validation is LOUD and total, by hard-won rule: unknown tags, unknown modes, unknown FIELDS,
 *   and out-of-range thresholds all throw with the offending path. (A silently-accepted
 *   `minimumConfidence` typo cost a debugging session on 2026-06-10 — `set()` is structurally
 *   typed and won't save a JSON file. This loader is where the contract is enforced.)
 */

import { COMPONENT_TAGS, type ComponentTag } from "../types/component.js"
import type { PolicyMode } from "./policy.js"
import { InMemoryPolicyRegistry } from "./registry.js"

const POLICY_MODES: readonly PolicyMode[] = ["rule_only", "neural_only", "both", "neural_preferred", "rule_preferred"]
const ENTRY_FIELDS = new Set(["mode", "confidence_threshold"])
const TAG_SET = new Set<string>(COMPONENT_TAGS)

/** The JSON shape of one tag's policy in a config file. */
export interface PolicyConfigEntry {
	mode: PolicyMode
	confidence_threshold?: number
}

/** The JSON shape of a policy config file: locale (or `"*"` for global) → tag → entry. */
export type PolicyConfig = Record<string, Record<string, PolicyConfigEntry>>

/**
 * Build a registry from a parsed policy-config object. Starts from `withDefaults()` (every tag
 * `rule_only`) and overlays the config's entries — so an absent tag behaves exactly as today.
 * Throws on ANY unrecognized key or value; the error names the offending JSON path.
 */
export function policyRegistryFromConfig(config: PolicyConfig): InMemoryPolicyRegistry {
	if (typeof config !== "object" || config === null || Array.isArray(config)) {
		throw new Error("policy config: root must be an object of locale → tag → entry")
	}
	const registry = InMemoryPolicyRegistry.withDefaults()

	for (const [localeKey, tags] of Object.entries(config)) {
		if (typeof tags !== "object" || tags === null || Array.isArray(tags)) {
			throw new Error(`policy config: "${localeKey}" must be an object of tag → entry`)
		}
		const locale = localeKey === "*" ? undefined : localeKey

		for (const [tag, entry] of Object.entries(tags)) {
			const path = `"${localeKey}"."${tag}"`
			if (!TAG_SET.has(tag)) {
				throw new Error(`policy config: ${path} is not a ComponentTag (see core/types/component.ts)`)
			}
			if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
				throw new Error(`policy config: ${path} must be an object with a "mode" field`)
			}
			for (const field of Object.keys(entry)) {
				if (!ENTRY_FIELDS.has(field)) {
					throw new Error(
						`policy config: ${path}."${field}" is not a recognized field (allowed: ${[...ENTRY_FIELDS].join(", ")})`,
					)
				}
			}
			if (!POLICY_MODES.includes(entry.mode)) {
				throw new Error(`policy config: ${path}.mode "${entry.mode}" is not one of ${POLICY_MODES.join(" | ")}`)
			}
			if (entry.confidence_threshold !== undefined) {
				const t = entry.confidence_threshold
				if (typeof t !== "number" || Number.isNaN(t) || t < 0 || t > 1) {
					throw new Error(`policy config: ${path}.confidence_threshold must be a number in [0, 1], got ${t}`)
				}
			}

			registry.set({
				component: tag as ComponentTag,
				mode: entry.mode,
				...(entry.confidence_threshold !== undefined ? { confidence_threshold: entry.confidence_threshold } : {}),
				...(locale ? { locale } : {}),
			})
		}
	}

	return registry
}
