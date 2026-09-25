/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Input perturbations for the invariance mini-suite, drawn from the metamorphic-testing literature.
 */

/**
 * Named perturbation with its literature citation.
 */
export interface Transform {
	id: string
	label: string
	/**
	 * One-line citation for the perturbation class.
	 */
	literatureAnchor: string
	/**
	 * Returns the perturbed string, or `null` when the perturbation does not apply to the input.
	 */
	apply: (raw: string) => string | null
}

/**
 * Removes every comma and collapses whitespace.
 * It returns `null` when the input has no comma.
 */
function commaDrop(raw: string): string | null {
	if (!raw.includes(",")) return null

	return raw.replaceAll(",", "").replaceAll(/\s+/g, " ").trim()
}

/**
 * English street-suffix abbreviations.
 *
 * The table is separate from the gauntlet's abbreviation source and omits French and German street types.
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
 * Street-suffix words.
 * A following word from this set means `st` is a suffix.
 */
const STREET_SUFFIX_WORDS = new Set(["avenue", "ave", "street", "st", "road", "rd"])

/**
 * Unit and floor markers.
 * A following word from this set means `st` is a suffix.
 */
const SECONDARY_DESIGNATOR_WORDS = new Set(["apt", "ste", "suite", "unit", "fl", "floor", "bldg", "rm", "room"])

/**
 * Reports whether the `st` token at index `i` is a Saint prefix.
 *
 * It is one when it has no trailing punctuation and the next word is capitalized
 * and is neither a street suffix nor a unit marker.
 *
 * The heuristic can skip a real suffix, which is safer than rewriting a place name such as `St Louis`.
 */
function isSaintPrefixFollower(tokens: string[], i: number): boolean {
	const ownBare = tokens[i]!.replace(/[.,]+$/, "")
	const ownTrail = tokens[i]!.slice(ownBare.length)

	if (ownTrail) {
		return false
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
 * Swaps the first supported suffix between its long and short forms, skipping Saint prefixes.
 * It returns `null` when the input has no supported suffix.
 */
function abbreviationSwap(raw: string): string | null {
	const tokens = raw.split(/(\s+)/)

	for (let i = 0; i < tokens.length; i++) {
		const bare = tokens[i]!.replace(/[.,]+$/, "")
		const trail = tokens[i]!.slice(bare.length)
		const lower = bare.toLowerCase()

		if (lower === "st" && isSaintPrefixFollower(tokens, i)) continue

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
 * Expands every supported abbreviation so that an abbreviation swap does not register as a component change.
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

/**
 * Uppercases the input.
 */
function caseFold(raw: string): string | null {
	return raw.toUpperCase()
}

/**
 * Lowercases the input.
 */
function lowercase(raw: string): string | null {
	return raw.toLowerCase()
}

/**
 * Doubles every space.
 * It returns `null` when the input has no space.
 */
function whitespaceJitter(raw: string): string | null {
	if (!raw.includes(" ")) return null

	return raw.replaceAll(" ", "  ")
}

/**
 * Appends a period.
 */
function trailingPunct(raw: string): string | null {
	return `${raw}.`
}

/**
 * Wraps the input in double quotes, as a copied CSV cell would be.
 */
function wrapInQuotes(raw: string): string | null {
	return `"${raw}"`
}

/**
 * Appends an irrelevant parenthetical, which must leave the existing components unchanged.
 */
function addParenthetical(raw: string): string | null {
	return `${raw} (main entrance)`
}

/**
 * Returns the input unchanged.
 * The runner parses it twice to test determinism.
 */
function identity(raw: string): string | null {
	return raw
}

/**
 * Registered transforms.
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
 * Returns the transform with the given ID.
 *
 * @throws When the ID is unknown.
 */
export function getTransform(id: string): Transform {
	const t = BY_ID.get(id)

	if (!t) {
		throw new Error(`unknown invariance transform id "${id}" — known: ${TRANSFORMS.map((x) => x.id).join(", ")}`)
	}

	return t
}
