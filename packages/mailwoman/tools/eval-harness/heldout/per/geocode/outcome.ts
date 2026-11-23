// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A held-out row's geocode outcome: whether the geocode's resolved components
 *   and places equal the row's expected spans.
 *
 *   The parse outcome (`score/exact-parse`) reads the classifier's spans before the
 *   resolver runs, so a resolver change leaves it equal on both arms.
 *   This outcome reads what the resolver returns: the components of the resolved tree,
 *   with any retag the resolver made, and the admin hierarchy it placed.
 *
 *   Components.
 *   The expected side is each span's text under its tag.
 *
 *   The resolved side is every entry of `components` and of `dropped_components`.
 *   Values are compared after `foldCaseWhitespace`, as a multiset of `(tag, value)`.
 *
 *   Under the `whole` street convention every street-family value on either side becomes one `street`
 *   entry holding its words in sorted order, since the components keep no offsets to join by.
 *
 *   Places.
 *   Every expected span tagged with a place tag (`locality`, `dependent_locality`, `subregion`,
 *   `region`, `country`) must have a hierarchy entry with the same tag whose written value folds
 *   to the span's text: the place written was resolved at the level the answer key gives it.
 *   Hierarchy entries the input didn't write are not compared.
 *
 *   The row is exact when both hold.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { STREET_FAMILY_TAGS } from "@mailwoman/codex/component"
import { streetSpanConventionFor } from "@mailwoman/codex/labels/street/convention"
import type { GeocodeResult } from "@mailwoman/core/geocode"
import { foldCaseWhitespace } from "@mailwoman/normalize/fold"

import { type HeldoutRow, heldoutRowKind } from "#tools/eval-harness/heldout/per/country"
import type { GeocodeRequirement } from "#tools/eval-harness/release/requirements"

/**
 * Whether a geocode requirement reads `row`: a row of one of its countries that its
 * selector admits, from no capability-probe source, as `release/evaluate` selects it.
 */
export function geocodeRequirementSelects(
	req: Pick<GeocodeRequirement, "countries" | "select">,
	row: Pick<HeldoutRow, "country" | "source" | "span_tags">,
	probeSources: ReadonlySet<string>
): boolean {
	const select = req.select ?? {}

	if (!row.country || !req.countries.includes(row.country) || probeSources.has(row.source)) return false

	if (select.kinds && !select.kinds.includes(heldoutRowKind(row.source))) return false

	if (select.sources && !select.sources.includes(row.source)) return false

	return !select.withoutTags?.some((tag) => row.span_tags.includes(tag))
}

/**
 * The expected tags whose text must be placed in the resolved hierarchy.
 */
export const GEOCODE_PLACE_TAGS = [
	"locality",
	"dependent_locality",
	"subregion",
	"region",
	"country",
] as const satisfies readonly ComponentTag[]

/**
 * One row's geocode outcome.
 * Each list entry is `<tag>=<folded value>`.
 */
export interface HeldoutGeocodeOutcome {
	exact: boolean
	componentsExact: boolean
	placesExact: boolean
	/**
	 * Expected components the geocode didn't return.
	 */
	missing: string[]
	/**
	 * Returned components the answer key doesn't hold.
	 */
	additional: string[]
	/**
	 * Expected places no hierarchy entry holds at their tag.
	 */
	unplaced: string[]
}

/**
 * The part of a geocode result the outcome reads.
 */
export type GeocodeOutcomeInput = Pick<GeocodeResult, "components" | "dropped_components" | "hierarchy">

const STREET_FAMILY: ReadonlySet<string> = new Set(STREET_FAMILY_TAGS)
const PLACE_TAGS: ReadonlySet<string> = new Set(GEOCODE_PLACE_TAGS)

/**
 * Folds `(tag, value)` pairs into comparison keys, joining the street family under the `whole` convention.
 */
function componentKeys(pairs: ReadonlyArray<readonly [string, string]>, whole: boolean): string[] {
	const keys: string[] = []
	const streetWords: string[] = []

	for (const [tag, value] of pairs) {
		const folded = foldCaseWhitespace(value)

		if (!folded) continue

		if (whole && STREET_FAMILY.has(tag)) {
			streetWords.push(...folded.split(" "))
		} else {
			keys.push(`${tag}=${folded}`)
		}
	}

	if (streetWords.length) {
		keys.push(`street=${streetWords.toSorted().join(" ")}`)
	}

	return keys
}

/**
 * Removes each of `b` from `a` once, returning what `a` keeps.
 */
function multisetMinus(a: readonly string[], b: readonly string[]): string[] {
	const counts = new Map<string, number>()

	for (const key of b) {
		counts.set(key, (counts.get(key) ?? 0) + 1)
	}

	return a.filter((key) => {
		const n = counts.get(key) ?? 0

		if (!n) return true

		counts.set(key, n - 1)

		return false
	})
}

/**
 * Grades one geocode of one row against its expected spans, as the module documentation states.
 */
export function scoreGeocodeOutcome(row: HeldoutRow, result: GeocodeOutcomeInput): HeldoutGeocodeOutcome {
	const whole = streetSpanConventionFor(row.country) === "whole"

	const expectedPairs = row.span_tags
		.map((tag, i) => ({ tag, start: row.span_starts[i]!, value: row.raw.slice(row.span_starts[i], row.span_ends[i]) }))
		.toSorted((a, b) => a.start - b.start)
		.map(({ tag, value }) => [tag, value] as const)

	const resolvedPairs = [
		...Object.entries(result.components).flatMap(([tag, value]) =>
			typeof value === "string" ? [[tag, value] as const] : []
		),
		...(result.dropped_components ?? []).map((dropped) => [dropped.tag, dropped.value] as const),
	]

	const expected = componentKeys(expectedPairs, whole)
	const resolved = componentKeys(resolvedPairs, whole)
	const missing = multisetMinus(expected, resolved)
	const additional = multisetMinus(resolved, expected)

	const placed = new Set(result.hierarchy.map((entry) => `${entry.tag}=${foldCaseWhitespace(entry.value)}`))

	const unplaced = expectedPairs
		.filter(([tag]) => PLACE_TAGS.has(tag))
		.map(([tag, value]) => `${tag}=${foldCaseWhitespace(value)}`)
		.filter((key) => !placed.has(key))

	const componentsExact = !missing.length && !additional.length
	const placesExact = !unplaced.length

	return {
		exact: componentsExact && placesExact,
		componentsExact,
		placesExact,
		missing,
		additional,
		unplaced,
	}
}
