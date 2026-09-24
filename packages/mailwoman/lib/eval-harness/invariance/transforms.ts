/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Define pure input perturbations for the invariance mini-suite.
 *   Transform classes follow metamorphic-testing literature, not project-specific failures.
 *   `apply` returns `null` when a transform does not apply.
 */

/**
 * A named perturbation with its literature reference and pure transform.
 */
export interface Transform {
	id: string
	label: string
	/**
	 * One-line citation grounding the class in the metamorphic-testing / NLP-robustness literature.
	 */
	literatureAnchor: string
	/**
	 * Returns the perturbed string, or `null` when the class doesn't apply to this input.
	 */
	apply: (raw: string) => string | null
}

//#region comma-drop

/**
 * Remove every comma.
 *
 * Applicable only when the input carries at least one.
 */
function commaDrop(raw: string): string | null {
	if (!raw.includes(",")) return null

	return raw.replaceAll(",", "").replaceAll(/\s+/g, " ").trim()
}

//#endregion

//#region abbreviation-swap

/**
 * Narrow English street-suffix table, independent of the gauntlet's abbreviation source.
 * French and German street types are out of scope.
 */
const LONG_TO_SHORT = new Map([
	["avenue", "Ave"],
	["street", "St"],
	["road", "Rd"],
])

const SHORT_TO_LONG = new Map([
	["ave", "Avenue"],
	["st", "Street"],
	["rd", "Road"],
])

/**
 * Suffix words excluded by the Saint-prefix look-ahead.
 */
const STREET_SUFFIX_WORDS = new Set(["avenue", "ave", "street", "st", "road", "rd"])

/**
 * Unit and floor markers excluded from Saint-prefix detection.
 */
const SECONDARY_DESIGNATOR_WORDS = new Set(["apt", "ste", "suite", "unit", "fl", "floor", "bldg", "rm", "room"])

/**
 * Treat `st` as a Saint prefix when it is followed by a capitalized, non-suffix,
 * non-unit token and has no trailing punctuation.
 *
 * This heuristic may skip some genuine street suffixes, preferring that to corrupting place names.
 */
function isSaintPrefixFollower(tokens: string[], i: number): boolean {
	const ownBare = tokens[i]!.replace(/[.,]+$/, "")
	const ownTrail = tokens[i]!.slice(ownBare.length)

	if (ownTrail) {
		return false // phrase-final "St," — a suffix closing a phrase, never a Saint-prefix.
	}

	for (let j = i + 1; j < tokens.length; j++) {
		if (/^\s+$/.test(tokens[j]!)) continue

		const bare = tokens[j]!.replace(/[.,]+$/, "")

		if (!bare) return false

		const lower = bare.toLowerCase()

		return /^[A-Z]/.test(bare) && !STREET_SUFFIX_WORDS.has(lower) && !SECONDARY_DESIGNATOR_WORDS.has(lower)
	}

	return false
}

/**
 * Swap the first supported suffix, skipping tokens identified as Saint prefixes.
 */
function abbreviationSwap(raw: string): string | null {
	const tokens = raw.split(/(\s+)/)

	for (let i = 0; i < tokens.length; i++) {
		const bare = tokens[i]!.replace(/[.,]+$/, "")
		const trail = tokens[i]!.slice(bare.length)
		const lower = bare.toLowerCase()

		if (lower === "st" && isSaintPrefixFollower(tokens, i)) continue // Saint-prefix guard — see doc comment above.

		const long = LONG_TO_SHORT.get(lower)
		const short = SHORT_TO_LONG.get(lower)
		const swap = long ?? short

		if (swap) {
			const out = [...tokens]
			out[i] = swap + trail

			return out.join("")
		}
	}

	return null
}

/**
 * Expand supported abbreviations before comparing component values.
 *
 * This removes expected spelling changes while preserving span differences.
 */
export function canonicalizeAbbreviations(value: string): string {
	return value
		.split(/(\s+)/)
		.map((tok) => {
			const bare = tok.replace(/[.,]+$/, "")
			const trail = tok.slice(bare.length)
			const long = SHORT_TO_LONG.get(bare.toLowerCase())

			return long ? long + trail : tok
		})
		.join("")
}

//#endregion

//#region case-fold (ALL-CAPS) / lowercase

/**
 * All-caps the input.
 *
 * Always applicable — every string has a casing.
 */
function caseFold(raw: string): string | null {
	return raw.toUpperCase()
}

/**
 * All-lowercase the input.
 *
 * Always applicable.
 */
function lowercase(raw: string): string | null {
	return raw.toLowerCase()
}

//#endregion

//#region whitespace-jitter

/**
 * Double literal spaces; return `null` when none are present.
 */
function whitespaceJitter(raw: string): string | null {
	if (!raw.includes(" ")) return null

	return raw.replaceAll(" ", "  ")
}

//#endregion

//#region trailing-punct

/**
 * Append a trailing period.
 *
 * Always applicable.
 */
function trailingPunct(raw: string): string | null {
	return `${raw}.`
}

//#endregion

//#region paired-punct transforms

/**
 * Wrap the input in quotes, as when copying a quoted spreadsheet or CSV cell.
 */
function wrapInQuotes(raw: string): string | null {
	return `"${raw}"`
}

/**
 * Append an irrelevant parenthetical aside; existing components should remain unchanged.
 */
function addParenthetical(raw: string): string | null {
	return `${raw} (main entrance)`
}

//#endregion

//#region idempotence

/**
 * Return the input unchanged; the runner parses it twice to test determinism.
 */
function identity(raw: string): string | null {
	return raw
}

//#endregion

//#region registry

/**
 * Registered metamorphic transforms.
 */
export const TRANSFORMS: readonly Transform[] = [
	{
		id: "comma-drop",
		label: "comma-drop",
		literatureAnchor: "Ribeiro et al. 2020 (CheckList) INV — punctuation-removal invariance",
		apply: commaDrop,
	},
	{
		id: "abbreviation-swap",
		label: "abbreviation-swap",
		literatureAnchor: "Ribeiro et al. 2020 (CheckList) INV — synonym/abbreviation substitution invariance",
		apply: abbreviationSwap,
	},
	{
		id: "case-fold",
		label: "case-fold (ALL-CAPS)",
		literatureAnchor: "Segura et al. 2016 metamorphic-testing survey — casing as a standard surface-form MR class",
		apply: caseFold,
	},
	{
		id: "lowercase",
		label: "lowercase",
		literatureAnchor: "Segura et al. 2016 metamorphic-testing survey — casing as a standard surface-form MR class",
		apply: lowercase,
	},
	{
		id: "whitespace-jitter",
		label: "whitespace-jitter",
		literatureAnchor: "Ribeiro et al. 2020 (CheckList) INV — added/extra whitespace invariance",
		apply: whitespaceJitter,
	},
	{
		id: "wrap-in-quotes",
		label: "wrap-in-quotes",
		literatureAnchor:
			"Ribeiro et al. 2020 (CheckList) INV — irrelevant surrounding punctuation invariance (paired-punctuation audit)",
		apply: wrapInQuotes,
	},
	{
		id: "add-parenthetical",
		label: "add-parenthetical",
		literatureAnchor:
			"Ribeiro et al. 2020 (CheckList) INV — appending an irrelevant clause/aside invariance (paired-punctuation audit)",
		apply: addParenthetical,
	},
	{
		id: "trailing-punct",
		label: "trailing-punct",
		literatureAnchor: "Ribeiro et al. 2020 (CheckList) INV — irrelevant trailing punctuation invariance",
		apply: trailingPunct,
	},
	{
		id: "idempotence",
		label: "idempotence",
		literatureAnchor: "Chen et al. 1998 metamorphic testing — the identity relation (f(x) twice must agree)",
		apply: identity,
	},
] as const

const BY_ID = new Map(TRANSFORMS.map((t) => [t.id, t]))

/**
 * Look up a transform by id.
 *
 * @throws On an unknown id — a typo in `suite.jsonl` should fail loudly.
 */
export function getTransform(id: string): Transform {
	const t = BY_ID.get(id)

	if (!t) {
		throw new Error(`unknown invariance transform id "${id}" — known: ${TRANSFORMS.map((x) => x.id).join(", ")}`)
	}

	return t
}

//#endregion
