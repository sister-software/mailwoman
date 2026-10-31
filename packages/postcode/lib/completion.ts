/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Whether a partial postcode can still complete, and for which countries.
 *
 *   The answer keeps two kinds of evidence apart. Syntax completion states that some suffix makes the text a whole
 *   postcode under a country's rule, the rule `postcodeSyntax` compiles from libaddressinput and
 *   `written-forms.ts`. Membership reports whether a PFX1 prefix index holds an allocated prefix consistent with the
 *   text. A code can satisfy the syntax and be unallocated, and an index covers only part of some countries, so
 *   membership is a separate field with its own coverage and never changes the syntax answer.
 */

import { acceptPostcode, postcodeSyntax } from "#country-formats"
import { COUNTRY_POSTCODE_FORMAT_SOURCES } from "#country-formats/data"
import { PrefixAutomaton } from "#prefix/automaton"
import type { PostcodePrefixIndexResolver } from "#prefix/index"

/**
 * One country whose syntax the partial text can still complete to.
 */
export interface PostcodeSyntaxCompletion {
	readonly country: string
	/**
	 * Whether the text is already a whole postcode under the country's syntax, as `acceptPostcode` answers.
	 */
	readonly complete: boolean
}

/**
 * What the supplied PFX1 indexes say about one syntax-completable country.
 *
 * `observed`: an index for the country holds a prefix node that starts with the text,
 * or that the text starts with.
 * `unobserved`: the country has an index and none of its nodes is consistent with the text.
 *
 * Whether that means the prefix is unallocated depends on each index's `coverageNote`.
 * `out-of-coverage`: no supplied index is for the country.
 */
export interface PostcodeMembership {
	readonly country: string
	readonly evidence: "observed" | "unobserved" | "out-of-coverage"
	/**
	 * The scope of each index read for the country, such as `gb-esw`.
	 */
	readonly scopes: readonly string[]
	/**
	 * Each read index's `coverageNote`, in `scopes` order.
	 */
	readonly coverageNotes: readonly string[]
}

/**
 * The answer `canComplete` gives for one partial postcode.
 */
export interface PostcodeCompletionAnswer {
	/**
	 * Whether any candidate country's syntax can still complete the text.
	 */
	readonly canComplete: boolean
	/**
	 * The candidate countries whose syntax can complete the text, in candidate order.
	 */
	readonly syntax: readonly PostcodeSyntaxCompletion[]
	/**
	 * Candidate countries libaddressinput states no postcode syntax for.
	 * The answer cannot judge them.
	 */
	readonly withoutSyntax: readonly string[]
	/**
	 * Membership for each country in `syntax`, or null when the caller supplied no prefix index.
	 */
	readonly membership: readonly PostcodeMembership[] | null
}

/**
 * Options for `canComplete`.
 */
export interface CanCompleteOptions {
	/**
	 * The candidate country or countries.
	 * Every country with a stated syntax when absent.
	 */
	readonly countries?: string | readonly string[]
	/**
	 * PFX1 indexes to read membership from.
	 * Membership is null when absent.
	 */
	readonly prefixIndexes?: readonly PostcodePrefixIndexResolver[]
}

const automata = new Map<string, PrefixAutomaton>()

function automatonFor(country: string): PrefixAutomaton | null {
	const syntax = postcodeSyntax(country)

	if (!syntax) return null

	let automaton = automata.get(country)

	if (!automaton) {
		automaton = new PrefixAutomaton(syntax.pattern.source)
		automata.set(country, automaton)
	}

	return automaton
}

/**
 * Whether `text` can still complete to a whole postcode in `country`'s syntax.
 *
 * The check ignores leading whitespace, as `acceptPostcode` trims it.
 * The literal the country's layout prints before the postcode, such as `MD-`,
 * may be partly typed, or typed whole and followed by the code.
 *
 * Whitespace at the end counts only where the syntax admits whitespace, or
 * when the trimmed text is already whole.
 */
function syntaxCanComplete(text: string, country: string, automaton: PrefixAutomaton): boolean {
	const value = text.trimStart()

	if (automaton.canComplete(value)) return true

	const prefix = postcodeSyntax(country)?.prefix

	if (prefix) {
		const upper = value.toUpperCase()

		if (prefix.startsWith(upper)) return true

		if (upper.startsWith(prefix) && automaton.canComplete(value.slice(prefix.length).trimStart())) return true
	}

	return acceptPostcode(value, country) != null
}

const sortedPrefixes = new WeakMap<PostcodePrefixIndexResolver, readonly string[]>()

/**
 * The index of the first entry of sorted `values` not less than `key`.
 */
function lowerBound(values: readonly string[], key: string): number {
	let lo = 0
	let hi = values.length

	while (lo < hi) {
		const mid = (lo + hi) >>> 1

		if (values[mid]! < key) {
			lo = mid + 1
		} else {
			hi = mid
		}
	}

	return lo
}

/**
 * Whether `index` holds a node that starts with `key` or that `key` starts with.
 */
function indexObserves(index: PostcodePrefixIndexResolver, key: string): boolean {
	let prefixes = sortedPrefixes.get(index)

	if (!prefixes) {
		prefixes = [...index.nodes()].map((node) => node.prefix.toUpperCase()).toSorted()
		sortedPrefixes.set(index, prefixes)
	}

	if (prefixes[lowerBound(prefixes, key)]?.startsWith(key)) return true

	// A node the key starts with is one of the key's heads, each looked up in turn.
	for (let n = 1; n <= key.length; n++) {
		const head = key.slice(0, n)

		if (prefixes[lowerBound(prefixes, head)] === head) return true
	}

	return false
}

function membershipFor(
	country: string,
	text: string,
	indexes: readonly PostcodePrefixIndexResolver[]
): PostcodeMembership {
	const own = indexes.filter((index) => index.country.toUpperCase() === country)

	if (!own.length) return { country, evidence: "out-of-coverage", scopes: [], coverageNotes: [] }

	const key = text.replaceAll(/[\s-]/gu, "").toUpperCase()

	return {
		country,
		evidence: own.some((index) => indexObserves(index, key)) ? "observed" : "unobserved",
		scopes: own.map((index) => index.header.scope),
		coverageNotes: own.map((index) => index.header.coverageNote),
	}
}

/**
 * Whether `text`, a partial postcode, can still complete to a syntactically
 * valid postcode, and for which countries.
 *
 * The syntax answer comes from `PrefixAutomaton`, compiled from the same pattern
 * `postcodeSyntax` matches whole, so a text answers true here at every prefix
 * length of every postcode `acceptPostcode` accepts.
 * Membership is reported beside it from the supplied PFX1 indexes and does not filter the syntax answer.
 *
 * @example
 *   canComplete("SW1", { countries: "GB" }).canComplete // true
 *   canComplete("12A", { countries: "US" }).canComplete // false
 */
export function canComplete(text: string, options: CanCompleteOptions = {}): PostcodeCompletionAnswer {
	const requested = options.countries ?? Object.keys(COUNTRY_POSTCODE_FORMAT_SOURCES)
	const countries = (typeof requested === "string" ? [requested] : requested).map((c) => c.toUpperCase())

	const syntax: PostcodeSyntaxCompletion[] = []
	const withoutSyntax: string[] = []

	for (const country of countries) {
		const automaton = automatonFor(country)

		if (!automaton) {
			withoutSyntax.push(country)

			continue
		}

		if (syntaxCanComplete(text, country, automaton)) {
			syntax.push({ country, complete: acceptPostcode(text, country) != null })
		}
	}

	const indexes = options.prefixIndexes

	return {
		canComplete: syntax.length > 0,
		syntax,
		withoutSyntax,
		membership: indexes ? syntax.map(({ country }) => membershipFor(country, text.trim(), indexes)) : null,
	}
}
