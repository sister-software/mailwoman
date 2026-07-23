/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The invariance mini-suite's perturbation classes — pure functions, no model, no I/O. Each class is
 *   imported from the METAMORPHIC-TESTING literature (Chen et al. 1998's original MR framing; Segura et
 *   al. 2016's survey of MR classes; Ribeiro et al. 2020 CheckList's INV taxonomy for NLP specifically),
 *   deliberately NOT derived from this project's own historical failures — the five-whys premise is that
 *   failure-derived cases only ever catch failures we've already had. `apply` returns `null` when the
 *   class doesn't apply to a given input (e.g. no swappable abbreviation token); the caller treats that as
 *   "not applicable", never as a violation.
 */

/** A perturbation class: a name, a one-line literature anchor, and the pure transform itself. */
export interface Transform {
	id: string
	label: string
	/** One-line citation grounding the class in the metamorphic-testing / NLP-robustness literature. */
	literatureAnchor: string
	/** Returns the perturbed string, or `null` when the class doesn't apply to this input. */
	apply: (raw: string) => string | null
}

// -------------------------------------------------------------------------------------------------
// comma-drop
// -------------------------------------------------------------------------------------------------

/** Remove every comma. Applicable only when the input carries at least one. */
function commaDrop(raw: string): string | null {
	if (!raw.includes(",")) return null

	return raw.replace(/,/g, "").replace(/\s+/g, " ").trim()
}

// -------------------------------------------------------------------------------------------------
// abbreviation-swap
// -------------------------------------------------------------------------------------------------

/**
 * Small, deliberately narrow EN street-suffix table (Ave↔Avenue, St↔Street, Rd↔Road) — the spec's own wording, not the
 * full `normalize/abbreviations.ts` dictionary the gauntlet's metamorphic layer uses. Keeping it small and separate
 * means this suite exercises a DIFFERENT, independent perturbation source than the gauntlet — two implementations of
 * the same literature class, not one shared with an inherited bug. FR/DE street types (Rue, Boulevard, Straße, …) are
 * deliberately OUT OF SCOPE for this table; a row without an Ave/St/Rd token gets no abbreviation-swap case (documented
 * per-row in suite.jsonl).
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
 * Suffix words (both long and short spellings) the Saint-prefix look-ahead treats as "this IS a street suffix, not a
 * name".
 */
const STREET_SUFFIX_WORDS = new Set(["avenue", "ave", "street", "st", "road", "rd"])

/**
 * Secondary-address designators (unit/suite/floor markers) the look-ahead ALSO treats as "not name-shaped" — these are
 * capitalized like a proper noun but are never what follows a genuine Saint-prefix ("St Apt 4B" isn't a place name).
 * Without this set, `"123 Main St Apt 4B"` / `"...St Ste 1100"` would misread the street-suffix "St" as a Saint-prefix
 * purely because "Apt"/"Ste" are capitalized.
 */
const SECONDARY_DESIGNATOR_WORDS = new Set(["apt", "ste", "suite", "unit", "fl", "floor", "bldg", "rm", "room"])

/**
 * Heuristic Saint-prefix guard for a candidate "st" token — two discriminators, both must clear for the guard to fire:
 *
 * 1. The "st" token itself must NOT be phrase-final (no trailing comma/period of its own). A Saint-prefix is always
 *    immediately adjacent to the name it prefixes ("St Andrews", "St Ives") and so never carries its own trailing
 *    punctuation; a street SUFFIX often closes a phrase right before the next address component ("...Salmon St,
 *    Portland, ..."). This is what lets the guard tell "St Andrews" apart from "...Salmon St, Portland" even though
 *    both have "St" followed by a capitalized non-suffix word.
 * 2. The NEXT token must be capitalized and NOT itself a street-suffix word or a secondary-address designator — the shape
 *    of "St Andrews", "St Ives", "St Bedes". This is a FOLLOWING-token heuristic, not a positional one: a Saint-prefix
 *    isn't always string-initial (`"The Vicarage, St Andrews Street"` has "St" as the third token, not index 0 — a
 *    purely positional guard misses it and corrupts the name).
 *
 * Known limits: this still can't distinguish a genuine Saint-prefix from a street-suffix "St" immediately followed,
 * mid-phrase (no comma), by an ordinary capitalized word that ISN'T a designator or suffix — e.g. a street literally
 * named "St Rose Ave" read out of context. v1 accepts that residual false-exempt (an under-tested row) over a
 * false-swap (a corrupted ground-truth string): mislabeling "St Andrews" as a suffix breaks the test's own fixture,
 * which is worse than skipping a swap. A future tightening could check the following word against a gazetteer of known
 * Saint-prefixed place names instead of a fixed word list.
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
 * Swap the first matching Ave/Avenue/St/Street/Rd/Road token. A candidate "st" token is skipped when
 * `isSaintPrefixFollower` judges it a Saint-prefix (see that function's doc comment for the heuristic and its known
 * limits) — swapping it would silently corrupt the test's own ground truth rather than exercise the intended class.
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
 * Expand every Ave/St/Rd token in a component VALUE to its long form. Used by the runner to canonicalize BOTH sides of
 * an `abbreviation-swap` pair before comparing: the transform legitimately changes what text a span-extraction parser
 * copies into `street`/`street_suffix` (that's the point of it — "Ave" swapped to "Avenue" should reappear as
 * "Avenue"), so comparing raw values would flag the transform's own intended effect as a false violation.
 * Canonicalizing both sides to long-form isolates a REAL divergence (the model picking a different span, not just
 * echoing the swapped spelling) from the expected text change.
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

// -------------------------------------------------------------------------------------------------
// case-fold (ALL-CAPS) / lowercase
// -------------------------------------------------------------------------------------------------

/** ALL-CAPS the input. Always applicable — every string has a casing. */
function caseFold(raw: string): string | null {
	return raw.toUpperCase()
}

/** All-lowercase the input. Always applicable. */
function lowercase(raw: string): string | null {
	return raw.toLowerCase()
}

// -------------------------------------------------------------------------------------------------
// whitespace-jitter
// -------------------------------------------------------------------------------------------------

/**
 * Double every literal space character. Applicable only when the input carries a literal space — the guard checks the
 * SAME class of whitespace the mutation acts on (` `, not any `\s`), so a row whose only whitespace is e.g. a tab never
 * silently reports a no-op INVARIANT (the guard used to accept any `\s` while the mutation only ever touched `" "`, a
 * mismatch that could pass a row through untouched and misreport it as holding).
 */
function whitespaceJitter(raw: string): string | null {
	if (!raw.includes(" ")) return null

	return raw.replace(/ /g, "  ")
}

// -------------------------------------------------------------------------------------------------
// trailing-punct
// -------------------------------------------------------------------------------------------------

/** Append a trailing period. Always applicable. */
function trailingPunct(raw: string): string | null {
	return `${raw}.`
}

// -------------------------------------------------------------------------------------------------
// paired-punct (Task 9 audit — quotes, brackets, braces, parens, guillemets)
// -------------------------------------------------------------------------------------------------

/**
 * Wrap the WHOLE input in a matching straight-quote pair — the same "wrap the whole thing" idiom as `trailing-punct`,
 * but with a paired delimiter instead of a single trailing char. Mirrors a real, mundane input shape: an address
 * copy-pasted out of a spreadsheet cell or CSV field that still carries its enclosing quotes. Always applicable (every
 * string can be wrapped). A correct decode path strips the wrap (boundary-trim, see `core/decoder/build-tree.ts`'s
 * `trimBoundary`) and recovers the identical components — this is a genuine metamorphic invariance, not a semantic
 * change, so a violation here is a real paired-punctuation regression.
 */
function wrapInQuotes(raw: string): string | null {
	return `"${raw}"`
}

/**
 * Append an irrelevant bracketed aside — the paired-punctuation sibling of `trailing-punct`'s "add innocuous trailing
 * content" idiom (Ribeiro et al. 2020's INV class explicitly covers appending irrelevant clauses/asides). The
 * parenthetical content ("main entrance") never appears in any golden component for these rows, so every EXISTING
 * component (house_number, street, locality, postcode, …) must survive unchanged; the aside itself getting no tag (or a
 * `venue`/`unit`-shaped one) is not itself a violation — the runner's `compareComponents` only flags a degradation/loss
 * on components that were present before and change or vanish after.
 */
function addParenthetical(raw: string): string | null {
	return `${raw} (main entrance)`
}

// -------------------------------------------------------------------------------------------------
// idempotence
// -------------------------------------------------------------------------------------------------

/**
 * Identity — the text is NOT perturbed. The runner special-cases this id: it parses the ORIGINAL string twice (two
 * independent classifier calls, never reusing a cached result) and compares the two outputs. This is Chen et al.'s
 * original metamorphic identity relation (`f(x)` computed twice must agree), repurposed to catch nondeterminism in the
 * decode path rather than a text perturbation.
 */
function identity(raw: string): string | null {
	return raw
}

// -------------------------------------------------------------------------------------------------
// registry
// -------------------------------------------------------------------------------------------------

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
			"Ribeiro et al. 2020 (CheckList) INV — irrelevant surrounding punctuation invariance (paired-punctuation audit, Task 9)",
		apply: wrapInQuotes,
	},
	{
		id: "add-parenthetical",
		label: "add-parenthetical",
		literatureAnchor:
			"Ribeiro et al. 2020 (CheckList) INV — appending an irrelevant clause/aside invariance (paired-punctuation audit, Task 9)",
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

/** Look up a transform by id. Throws on an unknown id — a typo in `suite.jsonl` should fail loudly. */
export function getTransform(id: string): Transform {
	const t = BY_ID.get(id)

	if (!t) {
		throw new Error(`unknown invariance transform id "${id}" — known: ${TRANSFORMS.map((x) => x.id).join(", ")}`)
	}

	return t
}
