/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Bridge between Mailwoman's legacy `Classification` set (40+ internal labels including
 *   non-component states like `alpha`, `numeric`, `stop_word`) and the canonical `ComponentTag`
 *   schema used by the neural classifier.
 *
 *   The parity-fixture converter in `packages/mailwoman/lib/dev-tools` reads
 *   `legacyClassificationToComponentTag` to translate a `Classification`-keyed golden row into a
 *   `ComponentTag`-keyed eval fixture.
 *
 *   Not every legacy classification maps to a `ComponentTag`. Internal states (`alpha`, `area`,
 *   `start_token`, etc.) return `null`, and the converter records the row as dropped.
 *
 *   Intersection handling is coarse: the legacy `intersection` tag becomes `intersection_a`, because
 *   the legacy label carries no position that would distinguish `intersection_a` from
 *   `intersection_b`.
 */

import type { ComponentTag } from "@mailwoman/codex/component"

import type { Classification } from "#types/Classification"

/**
 * Static mapping table.
 *
 * Tags not in this table map to `null` (treated as "not a component" — internal classifier state).
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
 * Translate a legacy classification tag into a canonical {@link ComponentTag},
 * or `null` if the legacy tag has no externally visible component equivalent.
 */
export function legacyClassificationToComponentTag(legacy: Classification): ComponentTag | null {
	return LEGACY_TO_COMPONENT[legacy] ?? null
}

/**
 * The full set of legacy tags that have a `ComponentTag` mapping.
 */
export const MAPPED_LEGACY_CLASSIFICATIONS = Object.keys(LEGACY_TO_COMPONENT) as Classification[]

/**
 * Inverse of {@link LEGACY_TO_COMPONENT}.
 *
 * Picks the first legacy entry that maps to each component, for tags with multiple legacy
 * aliases (e.g. `intersection_a` and `intersection_b` both come from legacy `intersection`),
 * the deterministic "first wins" rule is documented and tested.
 */
const COMPONENT_TO_LEGACY: Partial<Record<ComponentTag, Classification>> = (() => {
	const out: Partial<Record<ComponentTag, Classification>> = {}

	for (const [legacy, component] of Object.entries(LEGACY_TO_COMPONENT) as Array<[Classification, ComponentTag]>) {
		if (!(component in out)) {
			out[component] = legacy
		}
	}

	return out
})()

/**
 * Translate a canonical {@link ComponentTag} into a legacy {@link Classification}.
 *
 * Returns `null` when the component has no legacy equivalent, such as the JP-specific tags.
 */
export function componentTagToLegacyClassification(component: ComponentTag): Classification | null {
	return COMPONENT_TO_LEGACY[component] ?? null
}
