/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Bridge between Mailwoman's legacy `Classification` set (40+ internal labels including
 *   non-component states like `alpha`, `numeric`, `stop_word`) and the canonical `ComponentTag`
 *   schema used by the neural classifier (per #5).
 *
 *   Not every legacy classification maps to a `ComponentTag`. Internal states (`alpha`, `area`,
 *   `start_token`, etc.) return `null` and are dropped by the adapter.
 *
 *   Intersection handling is intentionally coarse: the legacy `intersection` tag becomes
 *   `intersection_a` by default. Producing `intersection_a` vs `intersection_b` requires positional
 *   reasoning that the legacy classifiers don't expose; deferred to the neural model where the
 *   schema natively distinguishes them.
 */

import type { Classification } from "../classification/index.js"
import type { ComponentTag } from "./component.js"

/**
 * Static mapping table. Tags not in this table map to `null` (treated as "not a component" — internal classifier
 * state).
 */
const LEGACY_TO_COMPONENT: Partial<Record<Classification, ComponentTag>> = {
	country: "country",
	region: "region",
	locality: "locality",
	dependency: "dependent_locality",
	postcode: "postcode",
	house_number: "house_number",
	street: "street",
	street_prefix: "street_prefix",
	street_suffix: "street_suffix",
	unit: "unit",
	venue: "venue",
	intersection: "intersection_a",
}

/**
 * Translate a legacy classification tag into a canonical {@link ComponentTag}, or `null` if the legacy tag has no
 * externally visible component equivalent.
 */
export function legacyClassificationToComponentTag(legacy: Classification): ComponentTag | null {
	return LEGACY_TO_COMPONENT[legacy] ?? null
}

/**
 * The full set of legacy tags that have a `ComponentTag` mapping. Useful for adapter wrappers that filter the span
 * graph by "which legacy tags do I expect this classifier to produce."
 */
export const MAPPED_LEGACY_CLASSIFICATIONS = Object.keys(LEGACY_TO_COMPONENT) as Classification[]

/**
 * Inverse of {@link LEGACY_TO_COMPONENT}. Picks the FIRST legacy entry that maps to each component — for tags with
 * multiple legacy aliases (e.g. `intersection_a` and `intersection_b` both come from legacy `intersection`), the
 * deterministic "first wins" rule is documented and tested.
 */
const COMPONENT_TO_LEGACY: Partial<Record<ComponentTag, Classification>> = (() => {
	const out: Partial<Record<ComponentTag, Classification>> = {}

	for (const [legacy, component] of Object.entries(LEGACY_TO_COMPONENT) as Array<[Classification, ComponentTag]>) {
		if (!(component in out)) out[component] = legacy
	}

	return out
})()

/**
 * Translate a canonical {@link ComponentTag} into a legacy {@link Classification}, or `null` when the component has no
 * legacy equivalent (e.g. JP-specific tags that don't exist in the rule path).
 *
 * Used by the parser-level proposal pipeline to write surviving neural proposals back into the `TokenContext`'s span
 * graph as classifications the solver can read.
 */
export function componentTagToLegacyClassification(component: ComponentTag): Classification | null {
	return COMPONENT_TO_LEGACY[component] ?? null
}
