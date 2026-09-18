/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Render a `ComponentTag`-keyed dict into a country-localized string — the inverse of the parser.
 *
 *   The order lives in `@mailwoman/codex/address-layouts`, as data. This module is the public surface over
 *   {@linkcode renderAddress}: {@linkcode formatAddress} is the join, and {@linkcode formatAddressRow} is the join plus
 *   the tags the layout printed, which is what every corpus adapter actually wants.
 *
 *   IT USED TO WRAP A THIRD-PARTY ENGINE, and 229 of this file's 438 lines existed to work around templates written
 *   against OpenStreetMap's tag vocabulary rather than this project's: a pass that parsed 295 mustache templates at
 *   module load to discover which of them could render a sub-locality, a second that spliced a missing line back in
 *   afterwards, a third that removed a connector the template wrote between two slots when one was empty, and a
 *   translation layer between the two vocabularies. Owning the layouts deletes all four — a layout that declares a
 *   `dependent_locality` slot needs no interrogation about whether it has one, and a line assembled from present values
 *   never writes a connector around an absent one.
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
	 * Replace the layout's line breaks with this separator. Default `"\n"`: the envelope form.
	 */
	separator?: string

	/**
	 * Join the lines the way the COUNTRY does, for the single-line form a query or a corpus row takes — `", "` for most,
	 * `" "` for Japan and Korea, and nothing at all for the Chinese-script systems, whose admin run is unseparated.
	 *
	 * It is an option rather than each caller's literal because the literal is wrong outside the anglophone systems:
	 * joining Japan's lines with a comma gives `1-9-1, 丸の内, 千代田区, 東京都 100-0005`, which is the romanized convention
	 * printed backwards. `separator` wins when both are given.
	 */
	singleLine?: boolean

	/**
	 * Which of the country's two orders to render in, or unset to read it off the components themselves.
	 *
	 * Eight countries write an address two ways, and which one a dict wants is a property of the VALUES, not of the
	 * country: `21 Jordan Road, Jordan, Kowloon` is the English register and `九龍佐敦佐敦道21號` is the Chinese one, both Hong
	 * Kong. Rendering either through one country-keyed layout prints one of them in an order nobody writes.
	 *
	 * A caller holding a parse tree has the better answer and should pass it — every span carries the script it is
	 * written in. This option is that hand-off.
	 */
	script?: AddressScript
}

function separatorFor(country: string, script: AddressScript, opts: FormatAddressOptions): string {
	if (opts.separator !== undefined) return opts.separator

	return opts.singleLine ? lineJoinForCountry(country, script) : "\n"
}

/**
 * The components consulted to decide the script, in the order they are asked.
 *
 * The street leads because it is the line that distinguishes the two registers while the rest of the address often does
 * not: a Hong Kong dict can carry `Kowloon` under either, and `佐敦道` under only one. The admin tiers follow as the
 * fallback for a dict with no street, and the postcode is never asked — a postal code is digits in both registers and
 * would abstain on every input.
 */
const SCRIPT_WITNESSES: readonly ComponentTag[] = ["street", "locality", "dependent_locality", "region", "venue"]

/**
 * Whether a string carries a letter written in something other than the Latin alphabet.
 *
 * This is not script classification, which `@mailwoman/query-shape` owns and answers in full ISO 15924. The question
 * here is binary and already scoped by the country: the eight records carrying two orders all pair a Latin register
 * with a non-Latin one, so "is this the Latin register" is the whole question a layout choice asks. Depending on
 * query-shape to ask it would give this package its first runtime dependency for one predicate.
 */
function carriesNonLatinLetter(value: string): boolean {
	return /\p{Letter}/u.test(value) && !/^[^\p{Letter}]*(?:\p{Script=Latin}[^\p{Letter}]*)+$/u.test(value)
}

/**
 * The script `components` are written in, read off the first witness that carries a letter.
 *
 * A dict whose witnesses are all digits or absent answers `undefined`, which leaves the country's own default in force
 * rather than guessing — the meaning-of-zero rule: no letters is not evidence of Latin.
 */
// repo-health-ignore export-name-affix -- core's `scriptOf` takes a CODEPOINT and answers its ISO 15924 script. this
// takes a dict and answers which of a country's two orders it is written for. Importing it is also impossible: this
// package carries no runtime dependency, and core is 11 MB of shipped data.
export function scriptOfComponents(components: ComponentDict): AddressScript | undefined {
	for (const tag of SCRIPT_WITNESSES) {
		const value = components[tag]?.trim()

		if (!value || !/\p{Letter}/u.test(value)) continue

		return carriesNonLatinLetter(value) ? "local" : "latin"
	}

	return undefined
}

/**
 * A dict naming every tag once, used to enumerate the slots a layout actually has.
 *
 * The enumeration is a RENDER rather than a walk of the layout structure, because a layout's alternatives and
 * connectors decide which slots are reachable and only the renderer resolves them.
 */
const EVERY_TAG: ComponentDict = Object.fromEntries(COMPONENT_TAGS.map((tag) => [tag, tag]))

/**
 * Per country: whether its Latin order places everything its local order does.
 */
const slotParity = new Map<string, boolean>()

/**
 * Whether reading the script off the components can cost `country` a component.
 *
 * Seven of the eight countries carrying two orders place slot for slot, so deriving the script drops no component.
 * Japan does not: its Latin skeleton has no slot below the prefecture, because the source models a romanized Japanese
 * address as prefecture plus undifferentiated address lines. A dict tagging `locality` and `dependent_locality`
 * separately loses both, which trades an order nobody writes for two components nobody gets.
 *
 * Computed from the layouts rather than listed, so a country whose Latin skeleton gains the missing slots starts
 * deriving with no edit here, and one that loses them stops.
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
 * Returns an empty string when the dict is empty, and when no layout names `country` — 55 of the 252 shipped country
 * records carry no usable skeleton, and answering nothing for one of those reports absence rather than inventing an
 * order. Throws nothing. a partial dict degrades to the parts the layout can print.
 */
export function formatAddress(components: ComponentDict, country: string, opts: FormatAddressOptions = {}): string {
	return formatAddressRow(components, country, opts)?.raw ?? ""
}

/**
 * A rendered address and the components that survived the render.
 */
export interface AddressRow {
	/**
	 * The rendered string.
	 */
	readonly raw: string
	/**
	 * The subset of the input dict the layout PRINTED, with the caller's original values. This is the half a corpus row
	 * needs: a label whose text is not in `raw` cannot be aligned against it.
	 */
	readonly components: ComponentDict
	/**
	 * Tags the dict carried a value for that the layout has no slot for, NAMED rather than silently dropped. France
	 * absorbing a region into its postcode line is the common case.
	 */
	readonly unplaced: readonly ComponentTag[]
	/**
	 * Which of the country's orders this row was rendered in — the caller's `script`, else the one read off the
	 * components, else the country's own default.
	 *
	 * Reported rather than inferred, because on a country with two orders the rendering alone does not say: a dict with
	 * no street and one admin tier prints the same string either way, and a corpus row that cannot name its register
	 * cannot be graded against one.
	 */
	readonly script: AddressScript
}

/**
 * Render `components` for `country` and report what the layout printed, in one pass.
 *
 * Returns null when nothing rendered — an empty dict, a country with no layout, or a dict whose every value falls in a
 * slot this country omits. Every corpus adapter asked both questions and paid for two renders to get them, then
 * recovered the alignment by searching the output string for each value. that search cannot tell a component the layout
 * dropped from one whose value happens to sit inside another — `Paris` inside `Rue de Paris`. The render knows, so the
 * answer is read rather than inferred.
 */
export function formatAddressRow(
	components: ComponentDict,
	country: string,
	opts: FormatAddressOptions = {}
): AddressRow | null {
	// The components decide, unless the caller does. Two abstentions leave the country's own default in force: a dict
	// with no letters attests no register, and a country whose Latin order would drop a component is not worth the
	// order. An explicit `script` overrides both — the caller holding a parse tree knows more than either test.
	const derived = scriptIsFreeToDerive(country) ? scriptOfComponents(components) : undefined
	const script = opts.script ?? derived ?? defaultScriptForCountry(country)
	const layout = layoutForCountry(country, script)

	if (!layout) return null

	const rendering = renderAddress(layout, components)

	if (!rendering.placed.length) return null

	const raw = joinRendering(rendering, separatorFor(country, script, opts))

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
 * This is a question about a string somebody else built — a committed golden fixture, a source's own address line — and
 * it is the WEAKER of the two reconciliations: a substring test cannot tell a component the renderer dropped from one
 * whose value happens to sit inside another. Anything rendered through a layout should read
 * {@linkcode formatAddressRow}'s `components` instead, which the render knows rather than infers.
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
