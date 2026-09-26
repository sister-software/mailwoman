/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Render a `ComponentTag`-keyed dict into a country-localized string — the inverse of the parser. The order
 *   lives in `@mailwoman/codex/address-layouts`, as data; this module is the public surface over
 *   {@linkcode renderAddress}.
 */

import {
	defaultScriptForCountry,
	layoutForCountry,
	lineJoinForCountry,
	type AddressScript,
} from "#address/layouts/index"
import { joinRendering, renderAddress, type ComponentDict } from "#address/render"
import { COMPONENT_TAGS, type ComponentTag } from "#component"

export type { ComponentDict } from "#address/render"

/**
 * Options accepted by {@linkcode formatAddress} and {@linkcode formatAddressRow}.
 */
export interface FormatAddressOptions {
	/**
	 * Replace the layout's line breaks with this separator.
	 *
	 * Default `"\n"`: the envelope form.
	 */
	separator?: string

	/**
	 * Join the lines the way the country does, for the single-line form a query
	 * or a corpus row takes; a caller's literal comma is wrong outside the anglophone
	 * systems, and `separator` wins when both are given.
	 */
	singleLine?: boolean

	/**
	 * Which of the country's two orders to render in, or unset to read it off the components themselves.
	 *
	 * Eight countries write an address two ways, and which one a dict wants is a property of the values
	 * rather than of the country; a caller holding a parse tree has the better answer and should pass it.
	 */
	script?: AddressScript
}

function separatorFor(country: string, script: AddressScript, opts: FormatAddressOptions): string {
	if (opts.separator !== undefined) return opts.separator

	return opts.singleLine ? lineJoinForCountry(country, script) : "\n"
}

/**
 * What replaces a break the layout marked soft.
 *
 * Down the page a soft break is an ordinary break: Great Britain prints the post town
 * and the postcode on their own lines and must keep doing so.
 * On one line it is a space, which is the whole reason the mark exists —
 * `London EC3N 1DE` rather than `London, EC3N 1DE`.
 *
 * An explicit `separator` overrides both.
 * A caller naming its own separator is asking for one string between every pair of lines,
 * and answering with two would ignore what it asked for.
 */
function softSeparatorFor(opts: FormatAddressOptions): string {
	if (opts.separator !== undefined) return opts.separator

	return opts.singleLine ? " " : "\n"
}

/**
 * The components consulted to decide the script, in the order they are asked, with the postcode
 * never asked because it is digits in both registers and would abstain on every input.
 */
const SCRIPT_WITNESSES: readonly ComponentTag[] = ["street", "locality", "dependent_locality", "region", "venue"]

/**
 * Whether a string carries a letter written in something other than the Latin alphabet;
 * every record carrying two orders pairs a Latin register with a non-Latin one,
 * so this binary answer is the whole question a layout choice asks.
 */
function carriesNonLatinLetter(value: string): boolean {
	return /\p{Letter}/u.test(value) && !/^[^\p{Letter}]*(?:\p{Script=Latin}[^\p{Letter}]*)+$/u.test(value)
}

/**
 * The script `components` are written in, read off the first witness that carries a letter;
 * no letters is not evidence of Latin, so all-digit or absent witnesses answer `undefined`
 * and leave the country's default in force.
 */
// repo-health-ignore export-name-affix -- core's `scriptOf` takes a codepoint
// and answers its ISO 15924 script.
// This takes a dict and answers which of a country's two orders it is written for.
// Importing it is also impossible: this package carries no runtime dependency,
// and core is 11 MB of shipped data.
export function scriptOfComponents(components: ComponentDict): AddressScript | undefined {
	for (const tag of SCRIPT_WITNESSES) {
		const value = components[tag]?.trim()

		if (!value || !/\p{Letter}/u.test(value)) continue

		return carriesNonLatinLetter(value) ? "local" : "latin"
	}

	return undefined
}

/**
 * A dict naming every tag once, used to enumerate the slots a layout actually has;
 * the enumeration is a render rather than a walk of the layout structure,
 * because only the renderer resolves which slots are reachable.
 */
const EVERY_TAG: ComponentDict = Object.fromEntries(COMPONENT_TAGS.map((tag) => [tag, tag]))

/**
 * Per country: whether its Latin order places everything its local order does.
 */
const slotParity = new Map<string, boolean>()

/**
 * Whether reading the script off the components can cost `country` a component;
 * Japan's Latin skeleton has no slot below the prefecture, so a dict tagging `locality`
 * and `dependent_locality` separately would lose both.
 */
function scriptIsFreeToDerive(country: string): boolean {
	const code = country.trim().toUpperCase()
	const known = slotParity.get(code)

	if (known !== undefined) return known

	const latin = layoutForCountry(code, "latin")
	const local = layoutForCountry(code, "local")

	const parity =
		!latin || !local || latin === local
			? true
			: renderAddress(local, EVERY_TAG).placed.every((tag) => renderAddress(latin, EVERY_TAG).placed.includes(tag))

	slotParity.set(code, parity)

	return parity
}

/**
 * Render a component dict into an idiomatic per-country address string.
 *
 * @returns An empty string when the dict is empty, when no layout names `country`
 * (55 of the 252 shipped records carry no usable skeleton), or when the layout prints
 * nothing; a partial dict degrades to the parts the layout can print.
 */
export function formatAddress(components: ComponentDict, country: string, opts: FormatAddressOptions = {}): string {
	return formatAddressRow(components, country, opts)?.raw ?? ""
}

/**
 * A rendered address and the components that survived the render.
 */
export interface AddressRow {
	readonly raw: string
	/**
	 * The subset of the input dict the layout printed, with the caller's original values.
	 *
	 * This is the half a corpus row needs: a label whose text is not in `raw` cannot be aligned against it.
	 */
	readonly components: ComponentDict
	/**
	 * Tags the dict carried a value for that the layout has no slot for, named rather than silently dropped.
	 *
	 * France absorbing a region into its postcode line is the common case.
	 */
	readonly unplaced: readonly ComponentTag[]
	/**
	 * Which of the country's orders this row was rendered in.
	 *
	 * The caller's `script`, else the one read off the components, else the country's own default.
	 *
	 * Reported rather than inferred, because on a country with two orders the rendering alone
	 * does not say: a dict with no street and one admin tier prints the same string either way,
	 * and a corpus row that cannot name its register cannot be graded against one.
	 */
	readonly script: AddressScript
}

/**
 * Render `components` for `country` and report what the layout printed, in one pass;
 * returns null when no slot rendered — an empty dict, a country with no layout,
 * or a dict whose every value falls in a slot this country omits.
 *
 * The render knows which component each piece came from, so a search of the output
 * string cannot mistake `Paris` inside `Rue de Paris` for a placed component.
 */
export function formatAddressRow(
	components: ComponentDict,
	country: string,
	opts: FormatAddressOptions = {}
): AddressRow | null {
	// An explicit `script` overrides both tests: a dict with no letters attests no register,
	// and a country whose Latin order would drop a component is not worth the order.
	const derived = scriptIsFreeToDerive(country) ? scriptOfComponents(components) : undefined
	const script = opts.script ?? derived ?? defaultScriptForCountry(country)
	const layout = layoutForCountry(country, script)

	if (!layout) return null

	const rendering = renderAddress(layout, components)

	if (!rendering.placed.length) return null

	const raw = joinRendering(rendering, separatorFor(country, script, opts), softSeparatorFor(opts))

	if (!raw) return null

	const placed: ComponentDict = {}

	for (const tag of rendering.placed) {
		const value = components[tag]

		if (value) {
			placed[tag] = value
		}
	}

	return { raw, components: placed, unplaced: rendering.unplaced, script }
}

/**
 * Which of `components` occur verbatim in `raw`, case- and whitespace-insensitively.
 *
 * A substring test cannot tell a component the renderer dropped from one whose value
 * happens to sit inside another, so anything rendered through a layout should read
 * {@linkcode formatAddressRow}'s `components` instead.
 */
export function componentsPresentIn(components: ComponentDict, raw: string): ComponentDict {
	const haystack = raw.toLowerCase().replaceAll(/\s+/g, " ")
	const out: ComponentDict = {}

	for (const [tag, value] of Object.entries(components)) {
		if (!value) continue

		if (haystack.includes(value.toLowerCase().replaceAll(/\s+/g, " "))) {
			out[tag as ComponentTag] = value
		}
	}

	return out
}
