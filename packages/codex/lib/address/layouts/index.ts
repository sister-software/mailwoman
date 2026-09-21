/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The per-country layout table. Each entry reads in the order it prints, so checking a country means looking at the
 *   shape of an address from there rather than at a nested call.
 *
 *   the line skeletons come from libaddressinput, Google's address metadata, which this repository already ships at
 *   `packages/core/data/chromium-i18n/ssl-address/` (252 countries, Apache-2.0) and already has a refresh command for
 *   (`mailwoman dev download ssl-address`). Its `fmt` field is the print order — `%N%n%O%n%A%n%C, %S %Z` for the United
 *   States — and it carries the two things the OpenStreetMap-derived templates get wrong for the locales this project
 *   publishes weights for: Japan's postal mark and largest-first order, and China's unseparated admin run.
 *
 *   what the dataset does not carry, and what is therefore authored here:
 *
 *   1. **The `%A` expansion.** libaddressinput models the street address as one opaque field, because its consumers
 *      hold it as free text. This project's `ComponentTag` union splits it into a house number, the four street-family
 *      tags, a unit and the two intersection tags, so each address system says how those fill the line. Six orders
 *      cover the world: number-first or number-last, crossed with a space, a comma, or a line of its own. Measured
 *      across the OpenCage templates, 183 of the 211 countries that carry both slots take one of the two space forms.
 *   2. **The line-join policy.** `%n` is a line break. Rendering it as `", "`, `" "` or `""` for single-line output is
 *      per-system, and it is the whole difference between a correct Japanese address and a reversed one.
 *
 *   3. **The country line.** `%R` is absent from nearly every `fmt`, because libaddressinput's consumers add the
 *      destination country themselves. It closes a small-first address and opens a large-first one, and it prints only
 *      when a caller supplies the name — an intra-country row carries none and prints none.
 *   4. **The post-office box.** The dataset models no box at all. the street node carries it, on its own line directly
 *      above the street.
 *
 *   Adding a country is therefore: transcribe its `fmt` skeleton, pick a street node, and close with the country line.
 *   A country whose real convention departs from the skeleton says so in place, with its source.
 */

import {
	addr,
	type AddressAtom,
	type AddressLayout,
	isAlternation,
	isLayout,
	isSlot,
	numberFirstCommaStreet,
	numberFirstStreet,
	numberLastCommaStreet,
	numberLastStreet,
	SLOTS,
	withSoftBreakBefore,
} from "#address/layout"
import {
	GENERATED_ADDRESS_LAYOUTS,
	GENERATED_LATIN_ADDRESS_LAYOUTS,
	GENERATED_LOCAL_ADDRESS_LAYOUTS,
} from "#address/layouts/generated"
import type { ComponentTag } from "#component"

export {
	GENERATED_ADDRESS_LAYOUTS,
	GENERATED_LATIN_ADDRESS_LAYOUTS,
	GENERATED_LOCAL_ADDRESS_LAYOUTS,
} from "#address/layouts/generated"

/**
 * Which script an address is written in, when a country writes two different orders.
 *
 * `local` is the country's own script — what libaddressinput's `fmt` states.
 * `latin` is its `lfmt`.
 *
 * Eight of the 252 shipped records carry a distinct pair: CN, HK, JP, KP, KR, MO, TH, TW.
 * Every other country writes one order in both, so the distinction reads through to the same layout.
 */
export type AddressScript = "local" | "latin"

const { attention, venue, house_number, street, dependent_locality, locality, subregion, region, postcode, country } =
	SLOTS

/**
 * The admin run below the prefecture in Japan, printed without separators.
 *
 * Japan's `fmt` carries no `%C` or `%D`, so everything below the prefecture rides the street-address field.
 */
export const japaneseSubPrefecture = addr`${subregion}${locality}${dependent_locality}${house_number}`

/**
 * China's street line: the name then the number, unseparated, below an admin
 * run its `fmt` prints as `%S%C%D`.
 */
export const chineseStreet = addr`${street}${house_number}`

/**
 * How a system joins its lines for single-line output.
 *
 * Absent reads as `", "`, the anglophone default.
 *
 * The CJK entries are the reason this is per-system rather than a caller's argument:
 * joining Japan's lines with a comma produces `1-9-1, 丸の内, 千代田区, 東京都 100-0005`,
 * which is the romanized convention printed backwards.
 */
export const LINE_JOINS: Readonly<Record<string, string>> = {
	JP: " ",
	CN: "",
	TW: "",
	KR: " ",
	// Written in Han script the same way CN and TW are, and absent here for as long as
	// the table was keyed by country: Hong Kong's country answer is its english register,
	// so a Chinese join under that key would have reached the Latin ordering.
	// It is the local-script join, which is why {@link lineJoinForCountry} asks which script first.
	HK: "",
	MO: "",
	// Korean, and the same split KR already states.
	KP: " ",
}

/**
 * Whether the country named by `countryCode` prints the largest unit first, in `script`.
 *
 * Every country carrying a distinct Latin order writes it smallest-first — all eight of them —
 * so asking for `latin` answers false wherever a second order exists.
 * That is not a coincidence to encode as a rule: it is read off the layout,
 * the same way the country answer is.
 */
export function isLargestFirstSystem(countryCode: string | null | undefined, script?: AddressScript): boolean {
	if (!countryCode) return false

	const code = countryCode.trim().toUpperCase()

	if (script === "latin") {
		const latin = GENERATED_LATIN_ADDRESS_LAYOUTS[code]

		if (latin) return layoutPrintsLargestFirst(latin) === true
	}

	return LARGEST_FIRST_SYSTEMS.has(code)
}

/**
 * Which order a layout actually prints: `true` when its `region` line precedes its street line.
 *
 * `null` when the layout names no region or no street, which several island and city-state records do.
 * Those carry no order to contradict.
 *
 * A layout and {@link isLargestFirstSystem} can disagree, and when they do the render is wrong
 * in a way neither table shows on its own: the order comes from the layout while `LINE_JOINS`
 * is picked by the flag, so an address prints one system's sequence with another's separators.
 * `layouts.test.ts` compares the two for every country that has both.
 */
export function layoutPrintsLargestFirst(layout: AddressLayout): boolean | null {
	const tags = printedTags(layout)

	const regionAt = tags.indexOf("region")
	const streetAt = tags.findIndex((tag) => tag === "street" || tag === "house_number")

	if (regionAt === -1 || streetAt === -1) return null

	return regionAt < streetAt
}

/**
 * Every slot a layout prints, in print order, flattened across lines.
 *
 * Flat rather than per line because the CJK systems put the whole admin run on one line.
 * Japan's prefecture and its sub-prefecture run share a line, so a comparison
 * of line indices reads them as unordered.
 */
function printedTags(layout: AddressLayout): ComponentTag[] {
	const tags: ComponentTag[] = []

	const visit = (atom: AddressAtom): void => {
		if (isSlot(atom)) {
			tags.push(atom.tag)
		} else if (isLayout(atom)) {
			for (const line of atom.lines) {
				for (const inner of line) {
					visit(inner)
				}
			}
		} else if (isAlternation(atom)) {
			// The first alternative is the one that renders when both could.
			// An alternation never reorders region against street, so reading one is enough to locate them.
			for (const inner of atom.alternatives) {
				visit(inner)
			}
		}
	}

	visit(layout)

	return tags
}

/**
 * Per-country layouts for the locales this project publishes weights for.
 *
 * Each is the country's libaddressinput `fmt` skeleton with `%A` expanded.
 * The `fmt` is quoted beside it so the two can be compared without opening the dataset.
 */
export const ADDRESS_LAYOUTS: Readonly<Record<string, AddressLayout>> = {
	// %N%n%O%n%A%n%C, %S %Z
	US: addr`${attention}
${venue}
${numberFirstStreet}
${locality}, ${region} ${postcode}
${country}`,

	// %O%n%N%n%A%n%Z %C
	FR: addr`${venue}
${attention}
${numberFirstStreet}
${dependent_locality}
${postcode} ${locality}
${country}`,

	// %N%n%O%n%A%n%C%n%Z — the postcode takes its own line down the page, and a space on one line.
	//
	// Royal Mail prints the post town and the postcode on separate lines,
	// which is what the multi-line render must keep.
	// Written on one line Great Britain puts a space between them: `27 Minories, London EC3N 1DE`. #1366
	// pinned that form and three tests assert it, and it is the majority register in attested data.
	// `wof-postalcode` carries 10,282,560 GB rows without the comma against 3,265,642 with.
	// The soft break is how one layout says both.
	GB: withSoftBreakBefore(
		addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${postcode}
${country}`,
		"postcode"
	),

	// %N%n%O%n%A%n%Z %C
	DE: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${postcode} ${locality}
${country}`,

	// %N%n%O%n%A%n%Z %C %S — Spain writes the number after a comma: `Calle Mayor, 12`.
	ES: addr`${attention}
${venue}
${numberLastCommaStreet}
${dependent_locality}
${postcode} ${locality} ${region}
${country}`,

	// %N%n%O%n%A%n%Z %C %S
	IT: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${postcode} ${locality} ${region}
${country}`,

	// %N%n%O%n%A%n%C %Z%n%S — India writes the number before a comma: `12, MG Road`.
	IN: addr`${attention}
${venue}
${numberFirstCommaStreet}
${dependent_locality}
${locality} ${postcode}
${region}
${country}`,

	// %N%n%O%n%A%n%D%n%C %Z
	NZ: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality} ${postcode}
${country}`,

	// %O%n%N%n%A%n%C %S %Z
	AU: addr`${venue}
${attention}
${numberFirstStreet}
${dependent_locality}
${locality} ${region} ${postcode}
${country}`,

	// 〒%Z%n%S%n%A%n%O%n%N, with the prefecture joined to the run below it.
	//
	// The dataset breaks the line between %S and %A because an envelope prints them on separate lines.
	// Written on one line — which is what a geocoder query and a corpus row are — the whole admin
	// run is unseparated and only the postal code takes a space: `〒100-0005 東京都千代田区丸の内1-9-1`.
	// Keeping the dataset's break would put a space after the prefecture, which no Japanese address carries.
	JP: addr`${country}
〒${postcode}
${region}${japaneseSubPrefecture}
${venue}
${attention}`,

	// %Z%n%S%C%D%n%A%n%O%n%N — the admin run prints unseparated, which is what `LINE_JOINS.CN` carries.
	CN: addr`${country}
${postcode}
${region}${locality}${dependent_locality}
${chineseStreet}
${venue}
${attention}`,

	// %S%n%C%n%A%n%O%n%N — the generated skeleton is libaddressinput's `fmt`, which is the chinese
	// field order, and the renderer joins it with `", "` because `LINE_JOINS` has no HK entry.
	// That combination prints `KLN, YAU tsim mong district, 21 jordan road`, which is neither register.
	//
	// Hong Kong writes both.
	// The Chinese form is `九龍油尖旺佐敦道21號` and the English form is `21 Jordan Road, Yau Tsim Mong, Kowloon`,
	// and this table holds one layout per country, so it holds the Latin one —
	// which is what `isLargestFirstSystem("HK") === false` already asserts
	// and `LINE_JOINS`'s absent HK entry already assumes.
	// The local-script order returns when the table is keyed by (country, script).
	//
	// No postcode line: Hong Kong operates no postcode system.
	HK: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${region}
${country}`,
}

/**
 * Address systems that print the largest unit first.
 *
 * Derived from the layouts rather than listed, because the layout is the statement of
 * print order and a hand-kept set beside it is a second answer to one question.
 * The set held four entries — JP, CN, TW, KR — while the layout table printed largest-first
 * for seven: IR, KP and KZ were absent from the set and unaffected by it.
 *
 * A caller composing its own order — a gazetteer hierarchy string, which is a query
 * rather than an address — reads this instead of re-deriving it. 122 of the 197 layouts name
 * no region or no street and state no order, so they are absent here and a caller treats
 * them as small-first, which is the anglophone default the rest of the table assumes.
 */
export const LARGEST_FIRST_SYSTEMS: ReadonlySet<string> = new Set(
	Object.entries({ ...GENERATED_ADDRESS_LAYOUTS, ...ADDRESS_LAYOUTS })
		.filter(([, layout]) => layoutPrintsLargestFirst(layout) === true)
		.map(([countryCode]) => countryCode)
)

/**
 * The layout for `country`, or null when neither table names it.
 *
 * The hand-authored entries take precedence: those are checked against real addresses
 * on a board, where a generated skeleton is a transcription of a dataset.
 * Null is a real answer — 55 of the 252 shipped country records carry no usable `fmt`, and a caller
 * that renders nothing for one of those is reporting absence rather than inventing an order.
 */
export function layoutForCountry(countryCode: string | null | undefined, script?: AddressScript): AddressLayout | null {
	if (!countryCode) return null

	const code = countryCode.trim().toUpperCase()

	if (script === "latin") {
		const latin = GENERATED_LATIN_ADDRESS_LAYOUTS[code]

		if (latin) return latin
	}

	const hand = ADDRESS_LAYOUTS[code]
	const local = GENERATED_LOCAL_ADDRESS_LAYOUTS[code]

	// A hand-authored entry states one order, and where the two scripts disagree it may be stating either.
	// Hong Kong's is the Latin one, so serving it as the local layout leaves that
	// country's own script unreachable.
	// The two print orders decide which it is: agreeing means the board-checked
	// entry is the local order and wins.
	// Disagreeing means it is the other script's, and the skeleton derived from
	// `fmt` is what the local order says.
	if (script === "local" && hand && local && layoutPrintsLargestFirst(hand) !== layoutPrintsLargestFirst(local)) {
		return local
	}

	return hand ?? GENERATED_ADDRESS_LAYOUTS[code] ?? null
}

/**
 * How the country named by `countryCode` joins its lines for single-line output, in `script`.
 *
 * The CJK joins belong to the local script alone.
 * Japan's lines joined with `" "` and Hong Kong's with `""` are right for `東京都千代田区丸の内1-9-1`,
 * and applying either to a Latin ordering is the state that printed a Chinese field
 * sequence with Latin separators: the order comes from the layout while the separator
 * came from a country flag, so the two could name different systems.
 *
 * Asking for a script makes them name one.
 */
export function lineJoinForCountry(countryCode: string | null | undefined, script?: AddressScript): string {
	if (!countryCode) return ", "

	const code = countryCode.trim().toUpperCase()

	if ((script ?? defaultScriptForCountry(code)) === "latin") return ", "

	return LINE_JOINS[code] ?? ", "
}

/**
 * Which script {@link layoutForCountry} answers in when no caller says.
 *
 * `local` everywhere except a country whose default layout prints the other order from its own
 * script's skeleton, which is Hong Kong: its hand-authored layout is the English register.
 * Therefore, a caller asking for no script gets the Latin ordering and must get the Latin separator with it.
 *
 * Reading the join off the layout that was picked is the whole fix.
 * Before, the order came from the layout and the separator from a country flag,
 * so the two could name different systems.
 */
export function defaultScriptForCountry(countryCode: string): AddressScript {
	const code = countryCode.trim().toUpperCase()
	const local = GENERATED_LOCAL_ADDRESS_LAYOUTS[code]
	const chosen = ADDRESS_LAYOUTS[code] ?? GENERATED_ADDRESS_LAYOUTS[code]

	if (!local || !chosen) return "local"

	return layoutPrintsLargestFirst(chosen) === layoutPrintsLargestFirst(local) ? "local" : "latin"
}
