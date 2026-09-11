/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Golden-set street-suffix relabel — v0.1.2 → v0.1.3.
 *
 *   ## Why this exists
 *
 *   The golden answer key and the training corpus disagreed about ONE thing, and the v9.0.0
 *   promotion eval read the disagreement as a model regression (`us.street` 87.4 vs a floor of
 *   87.8). The corpus SPLITS a US street into `street` + `street_suffix` — TIGER's adapter
 *   decomposes at `corpus/src/adapters/tiger/street-decompose.ts`, the `street-affix` slice recipe
 *   teaches it from USPS Pub-28, and `ComponentTag` carries `street_suffix` as a first-class tag.
 *   The golden set FOLDED it: 2,216 US rows carry a `street`, and exactly 2 of them label a
 *   `street_suffix`. Operator ruling, 2026-08-06: **the split is canonical**; the golden is the
 *   stale side. This tool moves the answer key onto the corpus convention.
 *
 *   ## The instrument
 *
 *   `matchTrailingSuffix` from `@mailwoman/codex/us` — the USPS Pub-28 Appendix C table, which is
 *   also what the corpus slice recipe splits on. The table is NOT re-implemented here, and the
 *   libpostal dictionary TIGER reads is deliberately not used: measured on this golden set the two
 *   disagree on 51 US rows, and the disagreements run in the codex table's favour (libpostal's
 *   `directionals.txt` lists `center|c`, so TIGER reads the `C` of "C STREET" as a directional
 *   prefix and then emits no suffix at all).
 *
 *   ## What it changes, and what it refuses to
 *
 *   Applied only to rows whose `country` is `US`. Three branches, mirroring the SHAPE of TIGER's
 *   `decomposeStreet` on codex tables:
 *
 *   - **street type** — the last whitespace-separated word is a Pub-28 suffix, and something is left
 *       over: "Main St" → `street: "Main"`, `street_suffix: "St"` (1,559 rows).
 *   - **street type + post-directional** — the last word is a directional AND the one before it is a
 *       Pub-28 suffix: "Pennsylvania Avenue NW" → `street: "Pennsylvania"`,
 *       `street_suffix: "Avenue NW"` (347 rows). The post-directional joins the suffix rather than
 *       becoming a tag of its own, because that is what the corpus adapter emits; there is no
 *       `street_postfix` tag to move it to.
 *   - **everything else is left folded** and reported. In particular a BARE post-directional tail
 *       ("Seymour East", "BROADWAY N" — 16 rows) is NOT split: a directional is not a Pub-28 suffix,
 *       and the observed rows in that class are unit-contaminated ("1ST AVE SW BOX E", where the
 *       trailing "E" is a box letter).
 *
 *   FR rows are untouched, deliberately and permanently as far as this tool is concerned. French
 *   street typology puts the type FIRST ("Rue de la Paix") and the golden labels only 7 of 665 FR
 *   street rows with a `street_prefix`; whether FR should split at all is a different question with
 *   a different table behind it, and nothing here should be read as having answered it.
 *
 *   ## Surface bytes
 *
 *   The split is a break at a whitespace run in the ORIGINAL string — no trimming, no case
 *   normalization, no re-joining of tokens. `street + gap + street_suffix` reconstructs the input
 *   byte-for-byte, so the whitespace between them belongs to neither span (the same shape the corpus
 *   adapter's spans have). The tool asserts this per row and refuses to write a file if it ever
 *   fails.
 */

import {
	isStreetDirectionalToken,
	matchTrailingSuffix,
	type USStreetSuffix,
	NAME_PRONE_US_SUFFIXES,
} from "@mailwoman/codex/us"
import { escapeRegExp } from "@mailwoman/core/strings/regexp"

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * A golden-set row, as stored one-per-line in `us.jsonl` / `fr.jsonl` / `adversarial.jsonl`. Only the fields this tool
 * reads are modeled; every other key rides through untouched.
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
 * What the tool decided about one row. Every value except the two `split-*` classes means "left folded".
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
 * A review trigger on a row the tool DID change. A flag is never an adjudication — it marks the row for the operator's
 * deck, and the split is applied either way.
 */
export interface GoldenRelabelFlag {
	kind: "name-prone-suffix" | "venue-context" | "remainder-is-affix"
	detail: string
}

/**
 * Row-level relabel outcome.
 */
export interface GoldenRelabelResult {
	/**
	 * The row to write. Identical object reference when nothing changed.
	 */
	row: GoldenStreetRow
	changed: boolean
	rowClass: GoldenRelabelClass
	flags: GoldenRelabelFlag[]
	/**
	 * A leading directional was lifted into `street_prefix` on this row.
	 */
	prefixSplit: boolean
	/**
	 * The street span as it stood in the parent version — recorded for the review deck.
	 */
	beforeStreet?: string
}

// ── The name-prone suffix set ──────────────────────────────────────────────

/**
 * Pub-28 canonicals that are also ordinary head nouns of PROPER NAMES — "Lincoln Park", "Boston Common", "Willow
 * Brook". A split on one of these is still applied (the table is the table), but the row lands in the review deck
 * because the trailing word may belong to the name rather than to the street type.
 *
 * Chosen against the surfaces this golden set actually carries (park 6, green 5, hill 7, heights 3, hollow 3, brook 3,
 * pass 3 — the whole flagged class is 60 rows of 1,906), not from the whole 200-entry table: flagging every possible
 * name-head would mark a third of the corrections and stop being a review artifact.
 */
// ── Byte-exact tail split ──────────────────────────────────────────────────

interface TailSplit {
	head: string
	gap: string
	tail: string
}

/**
 * Split `s` at its LAST whitespace run, returning the three pieces verbatim. Null when there is no interior whitespace,
 * when the head would be empty, or when `s` carries leading/trailing whitespace (a golden row is stored trimmed; an
 * untrimmed one is reported rather than silently normalized).
 */
function splitLastWord(s: string): TailSplit | null {
	if (s !== s.trim() || !s) return null
	const match = /^(.*\S)(\s+)(\S+)$/.exec(s)

	if (!match) return null

	return { head: match[1]!, gap: match[2]!, tail: match[3]! }
}

/**
 * Split `s` at its FIRST whitespace run — the leading-directional counterpart of {@link splitLastWord}. `head` is the
 * first word, `tail` the rest, both verbatim.
 */
function splitFirstWord(s: string): TailSplit | null {
	if (s !== s.trim() || !s) return null
	const match = /^(\S+)(\s+)(\S.*)$/.exec(s)

	if (!match) return null

	return { head: match[1]!, gap: match[2]!, tail: match[3]! }
}

// ── Row-level relabel ──────────────────────────────────────────────────────

/**
 * Rebuild `components` with `street_suffix` inserted immediately after `street`, so the written row reads in address
 * order rather than with the new tag appended at the end.
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
	 * Also lift a folded LEADING directional out into `street_prefix`. Default true.
	 *
	 * On by default because the fold applies both ways and the answer key has to be corrected on both, or the correction
	 * is not a correction: 207 of the 1,682 split dev rows (12.3%) still opened with a directional after the suffix move
	 * — "N Desmet Avenue" would have graded `street: "N Desmet"` against a model that says `street_prefix: "N", street:
	 * "Desmet"`. Turn it OFF only to measure what the prefix fold alone costs.
	 */
	splitPrefix?: boolean
}

/**
 * Decide, and apply, the US street-span split for ONE golden row. Pure: never mutates its argument, and returns the
 * same object reference when the row is left alone.
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
		// Street type + post-directional ("Pennsylvania Avenue NW"). The corpus adapter emits the pair as
		// ONE suffix span, and there is no post-directional tag to move it to.
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

	// Leading directional → street_prefix, on whatever name survived the suffix move. Independent of the
	// suffix branch, because "N Main" is as folded as "N Main St" is.
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

	// The invariant this tool exists to keep: the spans plus the whitespace between them ARE the original
	// span, byte for byte. Anything else means a token was rewritten.
	const rebuilt = `${prefix ? prefix + prefixGap : ""}${name}${suffix ? suffixGap + suffix : ""}`

	if (rebuilt !== street) {
		throw new Error(`golden-relabel: span reconstruction failed for ${JSON.stringify(street)}`)
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
			detail: `venue ${JSON.stringify(venue)} also carries ${JSON.stringify(suffix)}`,
		})
	}

	// Narrow on purpose: a name that happens to be a Pub-28 canonical is NOT interesting ("Mountain Rd",
	// "Valley Dr", "Mills Ln" are ordinary streets, and flagging them buried the deck — 108 rows of noise
	// on the first run). A name that is a bare DIRECTIONAL is: "East Rd" leaves `street: "East"`, which is
	// a direction, not a name.
	if (isStreetDirectionalToken(name)) {
		flags.push({
			kind: "remainder-is-affix",
			detail: `street would become the bare directional ${JSON.stringify(name)}`,
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
