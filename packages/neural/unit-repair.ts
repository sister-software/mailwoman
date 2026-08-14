/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Secondary-unit regex repair pass — parser-improvement backlog (2026-05-30).
 *
 *   The three-arena capability eval surfaced a persistent neural weakness: the model DROPS secondary
 *   units. "123 Main St Apt 456" → no unit label; the postal-standards secondary-unit edge class
 *   scored 0% neural. Units have a rigid surface shape (a designator keyword + an identifier), so —
 *   exactly like the postcode-repair pass (#35) — we can detect them deterministically and repair
 *   the BIO labels AFTER decode but BEFORE `buildAddressTree`. The model is untouched; this is a
 *   decoder-side correction, the same "lowest risk" lever family as postcode-repair.
 *
 *   PRECISION GUARDS (mirror postcode-repair — never regress a confident parse):
 *
 *   - We only fire on EXPLICIT designators (Apt, Ste, Suite, Unit, Rm, Floor, Bldg, Flat, … + bare
 *       "#<n>"). Ambiguous tokens are deliberately excluded: "Box" (that's po_box), bare "F"/"No"
 *       (too greedy), "Space"/"Stop" (common words).
 *   - ADD path (model emitted no unit over the matched run): allowed ONLY over `O` tokens — never over
 *       house_number / street* / postcode / po_box / a geographic container. So a
 *       confidently-labeled street or number is safe.
 *   - SNAP path: when the model already started a unit span inside the match, we expand/clip it to the
 *       full detected shape.
 *   - Local smear-clip: unit tokens immediately flanking a snapped run are cleared (mirrors
 *       postcode-repair) so "Apt 4 Springfield" can't leave a stray I-unit on "Springfield".
 *
 *   Opt-in via `ParseOpts.unitRepair` (postcode-repair earned default-on only after a measured
 *   +135/0; unit-repair stays opt-in until the v0.7.2 arena re-run quantifies its delta).
 */

import type { DecoderToken } from "@mailwoman/core/decoder"

import {
	type RepairResult,
	selectNonOverlappingMatches,
	type SpanMatch,
	tagOf,
	tokenIndicesOverlapping,
} from "./span-repair.ts"

export type { RepairResult } from "./span-repair.ts"

/**
 * A detected secondary-unit substring with its char range. Units carry no confidence class — every pattern here
 * requires an explicit designator, so there is no `kind` split like postcode-repair's.
 */
type UnitMatch = SpanMatch

/**
 * Secondary-unit shape patterns, ordered most-specific → least. Case-insensitive (unit designators appear in every
 * casing in real data). The identifier is a 1-5 digit number with an optional trailing letter ("4B"), a single letter
 * ("STE D"), or a letter+digits — kept tight so we don't swallow following words.
 */
const UNIT_DESIGNATORS =
	"APARTMENT|APT|SUITE|STE|UNIT|ROOM|RM|FLOOR|FLR|FL|BUILDING|BLDG|DEPARTMENT|DEPT|LOT|TRAILER|TRLR|SLIP|HANGAR|PIER|FLAT|PH|PENTHOUSE"

const UNIT_PATTERNS: Array<{ label: string; re: RegExp }> = [
	// Designator + optional "#"/"No." + identifier, e.g. "Apt 4B", "Ste 12", "STE D",
	// "Unit 9400", "Suite 100", "Rm 5", "Flat 2", "Apartment #3", "Bldg C".
	// The `\b` after the designator is essential: it stops "Unit" matching inside
	// "United", "Fl" inside "Florida", etc. The trailing `\b` on the identifier stops
	// "Apt Main" capturing the "M" of "Main" (single-letter ident only fires on a
	// standalone token like "STE D").
	{
		label: "designator",
		re: new RegExp(
			`\\b(?:${UNIT_DESIGNATORS})\\b\\.?\\s*#?\\s*(?:No\\.?\\s*)?(?:\\d{1,5}[A-Za-z]?|[A-Za-z]\\d{0,4})\\b`,
			"gi"
		),
	},
	// Bare hash + identifier, e.g. "#104", "# 4B". Common US secondary-unit form.
	{ label: "hash", re: /#\s*\d{1,5}[A-Za-z]?\b/g },
]

const UNIT_B = "B-unit" as DecoderToken["label"]
const UNIT_I = "I-unit" as DecoderToken["label"]
const OUTSIDE = "O" as DecoderToken["label"]

/**
 * Tags a unit span is allowed to overwrite on the ADD path. The v0.7.2 arena showed the dominant failure for bare
 * designator-led units ("Flat 2 14 Smith St", "APT 2 …") is the model labeling the WHOLE designator+identifier run as
 * `locality` — not leaving it `O`. An explicit designator + identifier is a high-confidence "this is a unit" shape (a
 * real locality/suburb name never has that form), so — exactly like postcode-repair's ADD_OVER_TAGS — we let it reclaim
 * a `locality`/`dependent_locality` span. Structural tags (house_number, street*, postcode, po_box, region, country,
 * venue) stay off the list so a confident parse is never clobbered. (`O` is always eligible.)
 */
const ADD_OVER_TAGS = new Set<string>(["locality", "dependent_locality"])

function isUnitLabel(label: string): boolean {
	return label === "B-unit" || label === "I-unit"
}

/**
 * Collect non-overlapping unit matches, preferring more-specific (earlier) patterns + longest.
 */
function collectMatches(text: string): UnitMatch[] {
	const candidates: UnitMatch[] = []

	UNIT_PATTERNS.forEach((pat, priority) => {
		pat.re.lastIndex = 0

		for (let m = pat.re.exec(text); m; m = pat.re.exec(text)) {
			candidates.push({ start: m.index, end: m.index + m[0].length, priority })
		}
	})

	return selectNonOverlappingMatches(candidates)
}

/**
 * Repair secondary-unit label spans in a decoded token sequence using designator regexes. Returns a NEW token array
 * (inputs are not mutated) plus a change count.
 */
export function repairUnitLabels(text: string, input: readonly DecoderToken[]): RepairResult {
	const matches = collectMatches(text)
	const tokens = input.map((t) => ({ ...t }))

	if (!matches.length) return { tokens, changed: 0 }

	let changed = 0

	const setLabel = (i: number, label: DecoderToken["label"]): void => {
		if (tokens[i]!.label !== label) {
			tokens[i]!.label = label

			changed++
		}
	}

	for (const m of matches) {
		const overlap = tokenIndicesOverlapping(tokens, m.start, m.end)

		if (!overlap.length) continue

		const hasUnit = overlap.some((i) => isUnitLabel(tokens[i]!.label))

		if (!hasUnit) {
			// ADD path — explicit designators are high-confidence, but only ever over O or a
			// geographic-container tag (locality/dependent_locality — the tags the model
			// mislabels bare units as). Never clobber a confident house_number/street/postcode/
			// po_box/region/country/venue.
			const safe = overlap.every((i) => {
				const tag = tagOf(tokens[i]!.label)

				return tag === null || ADD_OVER_TAGS.has(tag)
			})

			if (!safe) continue
		}

		// SNAP/ADD: relabel the matched run as a single unit span.
		overlap.forEach((i, k) => setLabel(i, k === 0 ? UNIT_B : UNIT_I))

		// Local smear clip: clear unit tokens immediately flanking the snapped run.
		for (let j = overlap[0]! - 1; j >= 0 && isUnitLabel(tokens[j]!.label); j--) {
			setLabel(j, OUTSIDE)
		}

		for (let j = overlap.at(-1)! + 1; j < tokens.length && isUnitLabel(tokens[j]!.label); j++) {
			setLabel(j, OUTSIDE)
		}
	}

	return { tokens, changed }
}
