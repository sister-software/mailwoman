/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Secondary-unit regex repair pass over a decoded token sequence, run after decode and before
 *   `buildAddressTree` with the model untouched.
 *
 *   The pass fires on explicit designators only, reclaims a span only when it is `O` or a
 *   `locality`/`dependent_locality` tag, and clears the unit tokens immediately flanking a
 *   repaired run.
 *
 *   Opt-in through `ParseOpts.unitRepair`.
 */

import type { DecoderToken } from "@mailwoman/core/decoder"

import {
	collectMatchesFor,
	createLabelSetter,
	isAddSafe,
	isTagLabel,
	type RepairResult,
	type SpanMatch,
	tokenIndicesOverlapping,
} from "#span/repair"

export type { RepairResult } from "#span/repair"

/**
 * A detected secondary-unit substring with its char range.
 *
 * Every pattern requires an explicit designator, so there is no `kind` split as in postcode-repair.
 */
type UnitMatch = SpanMatch

/**
 * Secondary-unit shape patterns, ordered most-specific first.
 *
 * The identifier is a 1-5 digit number with an optional trailing letter ("4B"), a single letter
 * ("STE D"), or a letter plus digits, kept tight so following words stay outside the match.
 */
const UNIT_DESIGNATORS =
	"APARTMENT|APT|SUITE|STE|UNIT|ROOM|RM|FLOOR|FLR|FL|BUILDING|BLDG|DEPARTMENT|DEPT|LOT|TRAILER|TRLR|SLIP|HANGAR|PIER|FLAT|PH|PENTHOUSE"

const UNIT_PATTERNS: Array<{ label: string; re: RegExp }> = [
	// The `\b` after the designator stops "Unit" matching inside "United" and "Fl" inside "Florida",
	// and the trailing `\b` on the identifier stops "Apt Main" capturing the "M" of "Main".
	{
		label: "designator",
		re: new RegExp(
			`\\b(?:${UNIT_DESIGNATORS})\\b\\.?\\s*#?\\s*(?:No\\.?\\s*)?(?:\\d{1,5}[A-Za-z]?|[A-Za-z]\\d{0,4})\\b`,
			"gi"
		),
	},
	// Bare hash plus identifier, a common US secondary-unit form.
	{ label: "hash", re: /#\s*\d{1,5}[A-Za-z]?\b/g },
]

const UNIT_B = "B-unit" as DecoderToken["label"]
const UNIT_I = "I-unit" as DecoderToken["label"]
const OUTSIDE = "O" as DecoderToken["label"]

/**
 * Tags a unit span is allowed to overwrite on the ADD path.
 *
 * An explicit designator plus identifier is a unit shape, so the pass reclaims a `locality` or
 * `dependent_locality` span, while a structural tag stays off the list so a confident parse is unchanged.
 * `O` is always eligible.
 */
const ADD_OVER_TAGS = new Set<string>(["locality", "dependent_locality"])

/**
 * Collect non-overlapping unit matches, preferring more-specific (earlier) patterns and longest.
 */
function collectMatches(text: string): UnitMatch[] {
	return collectMatchesFor(UNIT_PATTERNS, text).map(({ start, end, priority }) => ({ start, end, priority }))
}

/**
 * Repair secondary-unit label spans in a decoded token sequence using designator regexes.
 *
 * @returns A new token array (inputs are not mutated) plus a change count.
 */
export function repairUnitLabels(text: string, input: readonly DecoderToken[]): RepairResult {
	const matches = collectMatches(text)
	const tokens = input.map((t) => ({ ...t }))

	if (!matches.length) return { tokens, changed: 0 }

	const { setLabel, changeCount } = createLabelSetter(tokens)

	for (const m of matches) {
		const overlap = tokenIndicesOverlapping(tokens, m.start, m.end)

		if (!overlap.length) continue

		const hasUnit = overlap.some((i) => isTagLabel(tokens[i]!.label, "unit"))

		// The ADD path fires only over `O` or a `locality`/`dependent_locality` tag.
		if (!hasUnit && !isAddSafe(tokens, overlap, ADD_OVER_TAGS)) continue

		overlap.forEach((i, k) => setLabel(i, k === 0 ? UNIT_B : UNIT_I))

		for (let j = overlap[0]! - 1; j >= 0 && isTagLabel(tokens[j]!.label, "unit"); j--) {
			setLabel(j, OUTSIDE)
		}

		for (let j = overlap.at(-1)! + 1; j < tokens.length && isTagLabel(tokens[j]!.label, "unit"); j++) {
			setLabel(j, OUTSIDE)
		}
	}

	return { tokens, changed: changeCount() }
}
