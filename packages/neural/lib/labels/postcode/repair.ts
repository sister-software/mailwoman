// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { hasCountry } from "@mailwoman/codex/country/sets"
import type { DecoderToken } from "@mailwoman/core/decoder"
import { POSTCODE_SHAPES } from "@mailwoman/postcode/frozen-shapes"
import { findPostcodeHits } from "@mailwoman/postcode/postal-spans"

import type { AnchorSpanMode } from "#channels/anchor-inference"
import {
	collectMatchesFor,
	createLabelSetter,
	isAddSafe,
	isTagLabel,
	type RepairResult,
	selectNonOverlappingMatches,
	type SpanMatch,
	tagOf,
	tokenIndicesOverlapping,
} from "#span/repair"

/**
 * A detected postcode-shaped substring with its char range and confidence class.
 */
export interface PostcodeMatch extends SpanMatch {
	/**
	 * How far the repair may go without an existing postcode label in the range.
	 *
	 * `numeric` may only snap an existing postcode span.
	 * `alnum` may also add a span over admin-area labels.
	 *
	 * `designated` means digits after a postal marker and may overwrite any label.
	 */
	kind: "alnum" | "numeric" | "designated"
	/**
	 * Where the printed prefix before the code starts (`SE-`, `FO`), for a match of a printed shape.
	 *
	 * The repair leaves the prefix's labels as the model decoded them, so the model decides
	 * whether the prefix is part of the postcode.
	 */
	prefixStart?: number
}

/**
 * Lists the per-country postcode shape patterns, most specific first.
 *
 * The table is the frozen legacy table in `@mailwoman/postcode/frozen-shapes`.
 * Repair keeps it while model 10.8.0 is the published model, and it is deleted with the
 * legacy-formats family when the first model that declares `span_mode: "postal"` ships.
 */
export const POSTCODE_PATTERNS: ReadonlyArray<{
	label: string
	kind: "alnum" | "numeric" | "designated"
	re: RegExp
}> = POSTCODE_SHAPES

const ADD_OVER_TAGS = new Set<string>(["locality", "dependent_locality", "region", "subregion", "country"])

const POSTCODE_B = "B-postcode" as DecoderToken["label"]
const POSTCODE_I = "I-postcode" as DecoderToken["label"]
const LOCALITY_B = "B-locality" as DecoderToken["label"]
const LOCALITY_I = "I-locality" as DecoderToken["label"]
const OUTSIDE = "O" as DecoderToken["label"]

const FORM_RANK: Readonly<Record<PostcodeMatch["kind"], number>> = { designated: 0, alnum: 1, numeric: 2 }

/**
 * The frozen table's shapes that a postal mark designates, such as `S(…)` around a Singapore code.
 *
 * The family's printed shapes come from libaddressinput's prefixes.
 * Those prefixes hold no such mark.
 */
const MARKED_PATTERNS = POSTCODE_PATTERNS.filter((pattern) => pattern.kind === "designated")

/**
 * Whether a letter or a digit of any script touches the range, so the range splits a word.
 *
 * The family's engine bounds a candidate by ASCII letters and digits only,
 * so `6454 Fl` stands inside `6454 Flüelen`.
 */
function splitsWord(text: string, start: number, end: number): boolean {
	return /[\p{L}\p{N}]/u.test(text.charAt(start - 1)) || /[\p{L}\p{N}]/u.test(text.charAt(end))
}

/**
 * The postcode matches of a card that declares `span_mode: "postal"`, from the `postal` family.
 *
 * The candidates are the family's postcode hits (`findPostcodeHits`).
 * That reader refuses a candidate with no digit, a bare candidate that reads as
 * ordinary text such as `TX 75001`, and a connector fragment.
 *
 * A digit run keeps the `numeric` form whatever its shape allows.
 *
 * Here a hit is also refused when it splits a word.
 * A bare hit is refused when `country` is known and the hit's countries exclude it.
 *
 * The prefix of a printed hit states its country, and a hit inside a frozen postal
 * mark is `designated`, so neither is refused for the country.
 *
 * The hits that remain are reduced longest first, then by form, as the frozen table's matches are.
 * A match covers the code, and `prefixStart` marks where a printed prefix starts.
 */
function collectPostalMatches(text: string, country: string | null): PostcodeMatch[] {
	const marked = collectMatchesFor(MARKED_PATTERNS, text)

	const candidates = findPostcodeHits(text).flatMap((hit) => {
		if (splitsWord(text, hit.start, hit.end)) return []

		const isMarked = marked.some((m) => m.start === hit.codeStart && m.end === hit.end)
		const kind = isMarked ? "designated" : hit.form

		if (kind !== "designated" && country && !hasCountry(hit.countries, country)) return []

		return [{ hit, kind, start: hit.start, end: hit.end, priority: FORM_RANK[kind] }]
	})

	return selectNonOverlappingMatches(candidates).map(({ hit, kind }, priority) => ({
		start: hit.codeStart,
		end: hit.end,
		kind,
		priority,
		...(hit.codeStart > hit.start ? { prefixStart: hit.start } : {}),
	}))
}

/**
 * Collect non-overlapping postcode matches, preferring more-specific (earlier) patterns.
 *
 * A card that declares `span_mode: "postal"` reads the `postal` family,
 * and any other card reads the frozen table.
 *
 * @param country The row's country, from the caller's locale hint or the locale
 * classifier, read only by the `postal` family.
 */
export function collectMatches(
	text: string,
	spanMode?: AnchorSpanMode | null,
	country: string | null = null
): PostcodeMatch[] {
	if (spanMode === "postal") return collectPostalMatches(text, country)

	return collectMatchesFor(POSTCODE_PATTERNS, text).map(({ start, end, priority, pattern }) => ({
		start,
		end,
		kind: pattern.kind,
		priority,
	}))
}

/**
 * Relabels postcode spans in decoded tokens to match postcode-shaped substrings
 * of `text`, without mutating the input.
 *
 * A purely numeric match only corrects an existing postcode label and never creates one.
 *
 * @param country The row's country, read only under a `postal` card (see {@linkcode collectMatches}).
 * @returns The repaired tokens and the number of labels changed.
 */
export function repairPostcodeLabels(
	text: string,
	input: readonly DecoderToken[],
	spanMode?: AnchorSpanMode | null,
	country: string | null = null
): RepairResult {
	const matches = collectMatches(text, spanMode, country)
	const tokens = input.map((t) => ({ ...t }))

	if (!matches.length) return { tokens, changed: 0 }

	const { setLabel, changeCount } = createLabelSetter(tokens)

	for (const m of matches) {
		const overlap = tokenIndicesOverlapping(tokens, m.start, m.end)

		if (!overlap.length) continue

		const hasPostcode = overlap.some((i) => isTagLabel(tokens[i]!.label, "postcode"))

		if (!hasPostcode) {
			if (m.kind === "numeric") continue

			if (m.kind === "alnum" && !isAddSafe(tokens, overlap, ADD_OVER_TAGS)) continue
		}

		// A printed prefix the model labeled as postcode stays in the span with every postcode
		// label the model put before it, as the doubled prefix of `L-L-6735` shows.
		const prefix =
			typeof m.prefixStart === "number"
				? tokenIndicesOverlapping(tokens, m.prefixStart, m.start).filter((i) => i < overlap[0]!)
				: []

		const prefixInSpan = prefix.length > 0 && isTagLabel(tokens[prefix.at(-1)!]!.label, "postcode")

		overlap.forEach((i, k) => setLabel(i, k === 0 && !prefixInSpan ? POSTCODE_B : POSTCODE_I))

		const clearFrom = prefixInSpan ? -1 : overlap[0]! - 1

		for (let j = clearFrom; j >= 0 && isTagLabel(tokens[j]!.label, "postcode"); j--) {
			setLabel(j, OUTSIDE)
		}

		const trailing: number[] = []

		for (let j = overlap.at(-1)! + 1; j < tokens.length && isTagLabel(tokens[j]!.label, "postcode"); j++) {
			trailing.push(j)
		}

		if (trailing.length) {
			const after = trailing.at(-1)! + 1
			const connectsToCity = after < tokens.length && tagOf(tokens[after]!.label) === "locality"

			if (connectsToCity) {
				trailing.forEach((j, k) => setLabel(j, k === 0 ? LOCALITY_B : LOCALITY_I))

				if (tokens[after]!.label === "B-locality") {
					setLabel(after, LOCALITY_I)
				}
			} else {
				for (const j of trailing) {
					setLabel(j, OUTSIDE)
				}
			}
		}
	}

	return { tokens, changed: changeCount() }
}
