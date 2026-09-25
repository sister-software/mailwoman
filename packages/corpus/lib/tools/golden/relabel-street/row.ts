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
 * The golden row fields that the relabeler reads.
 * The relabeler copies other fields unchanged.
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
 * A review note on a changed row.
 * The relabel decision ignores it.
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
	/**
	 * Whether the relabeler moved a leading directional into `street_prefix`.
	 */
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
 * Splits `s` at its last whitespace run and returns the three pieces verbatim.
 *
 * The function returns `null` for an empty or untrimmed string or one without interior whitespace.
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
	 * The default is `true`.
	 *
	 * Without this split, `N Desmet Avenue` would grade as `street: "N Desmet"`
	 * against a model that emits a prefix.
	 */
	splitPrefix?: boolean
}

/**
 * Splits the street span of one US golden row.
 *
 * The function never mutates its argument and returns the input row itself when no field changes.
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
		// A street type and a post-directional, as in "Pennsylvania Avenue NW", form one suffix span.
		// The corpus adapter emits them that way because no post-directional tag exists.
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

	// The prefix split runs whether or not a suffix split happened.
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

	// The spans and the whitespace between them must rebuild the original street exactly.
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

	// Only a bare directional remainder is flagged, as in "East Rd".
	// A remainder that is a Pub-28 suffix word, as in "Valley Dr", is an ordinary street.
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
