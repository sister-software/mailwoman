/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Splits the street span of US golden rows into `street_prefix`, `street` and `street_suffix` with the USPS Pub-28 table.
 */

import {
	isStreetDirectionalToken,
	matchTrailingSuffix,
	type USStreetSuffix,
	NAME_PRONE_US_SUFFIXES,
} from "@mailwoman/codex/us"
import { stringifyJSON } from "@mailwoman/core/json"
import { escapeRegExp } from "@mailwoman/core/strings/regexp"

/**
 * The golden row fields that the relabeler reads; other fields are copied unchanged.
 */
export interface GoldenStreetRow {
	raw: string
	components: Record<string, string>
	country?: string
	source?: string
	notes?: string
	[key: string]: unknown
}

/**
 * The relabel outcome class for one row.
 */
export type GoldenRelabelClass =
	| "split-suffix"
	| "split-suffix-postdirectional"
	| "split-prefix-only"
	| "already-split"
	| "single-token"
	| "suffix-only-street"
	| "postdirectional-tail-only"
	| "no-suffix-match"
	| "no-street"
	| "not-us"
	| "untrimmed-street"

/**
 * A review note on a changed row, which the relabel decision ignores.
 */
export interface GoldenRelabelFlag {
	kind: "name-prone-suffix" | "venue-context" | "remainder-is-affix"
	detail: string
}

/**
 * The relabel result for one row.
 */
export interface GoldenRelabelResult {
	/**
	 * The row to write, which is the input object itself when no field changed.
	 */
	row: GoldenStreetRow
	changed: boolean
	rowClass: GoldenRelabelClass
	flags: GoldenRelabelFlag[]
	prefixSplit: boolean
	/**
	 * The original street span of a changed row, for review.
	 */
	beforeStreet?: string
}

interface TailSplit {
	head: string
	gap: string
	tail: string
}

/**
 * Splits `s` at its last whitespace run, or returns `null` for an empty, untrimmed, or single-token string.
 */
function splitLastWord(s: string): TailSplit | null {
	if (s !== s.trim() || !s) return null
	const match = /^(.*\S)(\s+)(\S+)$/.exec(s)

	if (!match) return null

	return { head: match[1]!, gap: match[2]!, tail: match[3]! }
}

/**
 * Splits `s` at its first whitespace run, with the same `null` cases as {@link splitLastWord}.
 */
function splitFirstWord(s: string): TailSplit | null {
	if (s !== s.trim() || !s) return null
	const match = /^(\S+)(\s+)(\S.*)$/.exec(s)

	if (!match) return null

	return { head: match[1]!, gap: match[2]!, tail: match[3]! }
}

/**
 * Rebuilds `components` with the street spans in place of `street`, so the keys stay in address order.
 */
function withStreetSpans(
	components: Record<string, string>,
	spans: { prefix?: string; street: string; suffix?: string }
): Record<string, string> {
	const out: Record<string, string> = {}

	for (const [key, value] of Object.entries(components)) {
		if (key === "street") {
			if (spans.prefix) {
				out.street_prefix = spans.prefix
			}

			out.street = spans.street

			if (spans.suffix) {
				out.street_suffix = spans.suffix
			}

			continue
		}

		if (key === "street_prefix" || key === "street_suffix") continue
		out[key] = value
	}

	return out
}

/**
 * Options for {@linkcode relabelGoldenStreetRow}.
 */
export interface RelabelStreetRowOptions {
	/**
	 * Whether to also move a leading directional into `street_prefix`.
	 *
	 * Defaults to `true`; without it `N Desmet Avenue` grades as `street: "N Desmet"`
	 * against a model that emits a prefix.
	 */
	splitPrefix?: boolean
}

/**
 * Splits the street span of one US golden row without mutating its argument,
 * returning it when no field changes.
 *
 * @throws When the split spans do not rebuild the original street byte for byte.
 */
export function relabelGoldenStreetRow(
	row: GoldenStreetRow,
	options: RelabelStreetRowOptions = {}
): GoldenRelabelResult {
	const splitPrefix = options.splitPrefix ?? true

	const keep = (rowClass: GoldenRelabelClass): GoldenRelabelResult => ({
		row,
		changed: false,
		rowClass,
		flags: [],
		prefixSplit: false,
	})

	if ((row.country ?? "").toUpperCase() !== "US") return keep("not-us")
	const street = row.components.street

	if (!street) return keep("no-street")

	if (row.components.street_suffix) return keep("already-split")

	if (street !== street.trim()) return keep("untrimmed-street")

	const flags: GoldenRelabelFlag[] = []
	let rowClass: GoldenRelabelClass
	let name = street
	let suffix: string | undefined
	let suffixGap = ""
	let canonical: USStreetSuffix | undefined

	const split = splitLastWord(street)

	if (!split) {
		rowClass = matchTrailingSuffix(street) ? "suffix-only-street" : "single-token"
	} else if (isStreetDirectionalToken(split.tail)) {
		// A street type and a post-directional, as in "Pennsylvania Avenue NW",
		// form one suffix span because no post-directional tag exists.
		const inner = splitLastWord(split.head)
		const typeMatch = inner ? matchTrailingSuffix(inner.tail) : null

		if (!inner || !typeMatch) {
			rowClass = "postdirectional-tail-only"
		} else {
			rowClass = "split-suffix-postdirectional"
			name = inner.head
			suffix = `${inner.tail}${split.gap}${split.tail}`
			suffixGap = inner.gap
			canonical = typeMatch.canonical
		}
	} else {
		const typeMatch = matchTrailingSuffix(street)

		if (!typeMatch) {
			rowClass = "no-suffix-match"
		} else {
			rowClass = "split-suffix"
			name = split.head
			suffix = split.tail
			suffixGap = split.gap
			canonical = typeMatch.canonical
		}
	}

	let prefix: string | undefined
	let prefixGap = ""

	if (splitPrefix && !row.components.street_prefix) {
		const lead = splitFirstWord(name)

		if (lead && isStreetDirectionalToken(lead.head)) {
			prefix = lead.head
			prefixGap = lead.gap
			name = lead.tail
		}
	}

	if (!suffix && !prefix) return keep(rowClass)

	if (!suffix) {
		rowClass = "split-prefix-only"
	}

	const rebuilt = `${prefix ? prefix + prefixGap : ""}${name}${suffix ? suffixGap + suffix : ""}`

	if (rebuilt !== street) {
		throw new Error(`golden-relabel: span reconstruction failed for ${stringifyJSON(street)}`)
	}

	if (canonical && NAME_PRONE_US_SUFFIXES.has(canonical)) {
		flags.push({
			kind: "name-prone-suffix",
			detail: `${canonical} heads proper names as often as street types`,
		})
	}

	const venue = row.components.venue

	if (suffix && venue && new RegExp(`(^|\\W)${escapeRegExp(suffix)}(\\W|$)`, "i").test(venue)) {
		flags.push({
			kind: "venue-context",
			detail: `venue ${stringifyJSON(venue)} also carries ${stringifyJSON(suffix)}`,
		})
	}

	// Only a bare directional remainder is flagged, as in "East Rd"; a Pub-28 suffix
	// word like "Valley Dr" is an ordinary street.
	if (isStreetDirectionalToken(name)) {
		flags.push({
			kind: "remainder-is-affix",
			detail: `street would become the bare directional ${stringifyJSON(name)}`,
		})
	}

	return {
		row: {
			...row,
			components: withStreetSpans(row.components, {
				...(prefix ? { prefix } : row.components.street_prefix ? { prefix: row.components.street_prefix } : {}),
				street: name,
				...(suffix ? { suffix } : {}),
			}),
		},
		changed: true,
		rowClass,
		flags,
		prefixSplit: Boolean(prefix),
		beforeStreet: street,
	}
}
