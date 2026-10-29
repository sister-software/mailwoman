/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Rows for an evaluation set that ends each address with its country, for the countries whose only training rows
 *   ending in a country are Who's On First place-name chains.
 *
 *   An OSM address row is rendered by the country's layout with the country's name added as a `country` component,
 *   so `Rruga Bylis 16, Tirane` becomes `Rruga Bylis 16, Tirane, Albania`. The row keeps the identity the corpus
 *   build gives the same address without the country (`osm-<cc>:<stable id>`), so an overlap audit finds the address
 *   in any corpus that trained on it.
 *
 *   A Who's On First chain is kept when its last two spans are a locality and its country, the
 *   `<locality>, <country>` reading the region misread competes with.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import type { ComponentTag } from "@mailwoman/codex/component"
import { sha256Hex } from "@mailwoman/core/hash"
import { locateComponentSpans } from "@mailwoman/corpus/utils/align"

import type { HeldoutRow } from "#tools/eval-harness/heldout/per/country"

/**
 * Renders an address's components with its country's name last, as a held-out row.
 *
 * @returns `null` when the layout renders no row, places no country,
 * or a component cannot be located in the text.
 */
export function trailingCountryRow(input: {
	components: Partial<Record<ComponentTag, string>>
	country: string
	countryName: string
	source: string
	sourceID: string
}): HeldoutRow | null {
	const rendered = formatAddressRow({ ...input.components, country: input.countryName }, input.country, {
		singleLine: true,
	})

	if (!rendered || !rendered.components.country || rendered.unplaced.length) return null

	if (!rendered.raw.endsWith(input.countryName)) return null

	const located = locateComponentSpans(rendered.raw, rendered.components)

	if ("reason" in located) return null

	return {
		raw: rendered.raw,
		span_starts: located.spans.map((span) => span.start),
		span_ends: located.spans.map((span) => span.end),
		span_tags: located.spans.map((span) => span.tag),
		country: input.country,
		source: input.source,
		source_id: input.sourceID,
		group: input.sourceID,
	}
}

/**
 * Whether a row's last two spans, in text order, are a locality and then its country.
 */
export function endsInLocalityCountry(row: Pick<HeldoutRow, "span_starts" | "span_tags">): boolean {
	const order = row.span_starts.map((start, i) => [start, row.span_tags[i]!] as const).toSorted((a, b) => a[0] - b[0])

	return order.length >= 2 && order.at(-1)![1] === "country" && order.at(-2)![1] === "locality"
}

const LATIN_NAME = /^[\p{Script=Latin}\s'’.-]+$/u

/**
 * The most frequent Latin-script text of the `country` span among rows,
 * the spelling the training chains use.
 *
 * When no Latin name occurs, the most frequent text in any script.
 */
export function commonCountryName(
	rows: ReadonlyArray<Pick<HeldoutRow, "raw" | "span_starts" | "span_ends" | "span_tags">>
): string | null {
	const names = countryNameCounts(rows)
	const latin = names.find(([name]) => LATIN_NAME.test(name))

	return (latin ?? names[0])?.[0] ?? null
}

function countryNameCounts(
	rows: ReadonlyArray<Pick<HeldoutRow, "raw" | "span_starts" | "span_ends" | "span_tags">>
): Array<[name: string, rows: number]> {
	const counts = new Map<string, number>()

	for (const row of rows) {
		for (const [i, tag] of row.span_tags.entries()) {
			if (tag !== "country") continue

			// An augmented chain doubles its spaces, so the name is counted with whitespace collapsed.
			const text = row.raw.slice(row.span_starts[i], row.span_ends[i]).replaceAll(/\s+/gu, " ").trim()

			counts.set(text, (counts.get(text) ?? 0) + 1)
		}
	}

	return [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/**
 * Keeps the first `limit` rows in a fixed order by the sha256 of their text, one per group.
 */
export function firstByTextHash<T extends Pick<HeldoutRow, "raw" | "group">>(rows: readonly T[], limit: number): T[] {
	const seen = new Set<string>()

	const ordered = rows
		.map((row) => ({ row, key: sha256Hex(row.raw) }))
		.toSorted((a, b) => a.key.localeCompare(b.key))
		.map(({ row }) => row)

	const kept: T[] = []

	for (const row of ordered) {
		if (kept.length >= limit) break

		if (seen.has(row.group)) continue

		seen.add(row.group)
		kept.push(row)
	}

	return kept
}
