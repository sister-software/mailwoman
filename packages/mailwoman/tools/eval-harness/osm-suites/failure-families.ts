/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The mechanism families of a suite failure list, by the rules of the 2026-10-28 myopia report's classifier over the
 *   list's expected and shipped component strings.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { countInto } from "@mailwoman/core/stats"
import { SINGLETON_TAGS } from "@mailwoman/neural/cardinality-filter"

/**
 * One failure-list entry: the input and the expected and shipped components,
 * each written `tag=value · tag=value`.
 */
export interface FailureRecord {
	input: string
	expected: string
	shipped: string
}

const pairs = (text: string) =>
	text
		.split(" · ")
		.filter((part) => part.includes("="))
		.map((part) => [part.slice(0, part.indexOf("=")), part.slice(part.indexOf("=") + 1)] as const)

const strip = (value: string) => value.replaceAll(/[()'’".]/g, "")

/**
 * The families one failure belongs to.
 * A failure can belong to several, or to none.
 */
export function failureFamilies(record: FailureRecord, country: string): string[] {
	const expected = pairs(record.expected)
	const shipped = pairs(record.shipped)
	const expectedTags = new Set(expected.map(([tag]) => tag))
	const shippedTags = new Set(shipped.map(([tag]) => tag))
	const expectedByTag = new Map(expected)
	const shippedByTag = new Map(shipped)
	const out: string[] = []

	if (country === "HK") {
		out.push("set-aside:hk")
	}

	if (/^[a-z]{2}-/.test(expectedByTag.get("postcode") ?? "")) {
		out.push("set-aside:postcode-prefix")
	}

	if (expectedTags.has("venue") && !shippedTags.has("venue")) {
		out.push("venue-lost")
	}

	if (expectedTags.has("unit") && !shippedTags.has("unit")) {
		const unit = expectedByTag.get("unit")!

		if (shipped.some(([tag, value]) => tag !== "unit" && value.includes(unit))) {
			out.push("unit-absorbed")
		}
	}

	if (expectedTags.has("dependent_locality") && !shippedTags.has("dependent_locality")) {
		const street = shippedByTag.get("street")

		if (street && street.includes(expectedByTag.get("dependent_locality")!)) {
			out.push("dependent-locality-as-street")
		}
	}

	const shippedCounts = new Map<string, number>()

	for (const [tag] of shipped) {
		countInto(shippedCounts, tag)
	}

	if ([...shippedCounts].some(([tag, count]) => SINGLETON_TAGS.has(tag as ComponentTag) && count > 1)) {
		out.push("singleton-repeated")
	}

	for (const [tag, value] of expected) {
		const got = shippedByTag.get(tag)

		if (got && got !== value && strip(got) === strip(value)) {
			out.push("punctuation-lost")

			break
		}
	}

	return out
}

/**
 * One failure-list entry with the suite and country it was listed under and its raw input.
 */
export interface ListedFailure {
	suite: string
	country: string
	raw: string
	entry: FailureRecord
}

/**
 * Reads a failure list in the shape the 2026-10-28 suite report wrote: `groups[suite][country][id]`,
 * each group's first entry a header row whose input is `Input`.
 */
export async function readFailureList(path: string): Promise<ListedFailure[]> {
	const failure = await readLocalJSONFile<{ groups: Record<string, Record<string, Record<string, FailureRecord>>> }>(
		path
	)

	return Object.entries(failure.groups).flatMap(([suite, countries]) =>
		Object.entries(countries).flatMap(([country, byID]) =>
			Object.values(byID)
				.filter((entry) => entry.input !== "Input")
				.map((entry) => ({ suite, country, entry, raw: entry.input.replaceAll(/^`|`$/g, "") }))
		)
	)
}
