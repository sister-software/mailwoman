/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The per-country layout table. Each entry reads in the order it prints, so checking a country means looking at
 *   the shape of an address from there rather than at a nested call.
 *
 *   The line skeletons come from libaddressinput, Google's address metadata, which this repository ships at
 *   `packages/core/data/chromium-i18n/ssl-address/` (252 countries, Apache-2.0). Its `fmt` field is the print order;
 *   what it does not carry, and what is authored here, is the `%A` expansion into this project's street tags, the
 *   line-join policy, the country line, and the post-office box.
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
 * Which script an address is written in when a country writes two different orders: `local` is
 * the country's own script, which libaddressinput's `fmt` states, and `latin` is its `lfmt`.
 *
 * Eight of the 252 shipped records carry a distinct pair (CN, HK, JP, KP, KR, MO, TH, TW)
 * and every other country writes one order in both.
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
 * How a system joins its lines for single-line output; absent reads as `", "`, the anglophone default,
 * and the CJK entries are the reason this is per-system rather than a caller's argument.
 */
export const LINE_JOINS: Readonly<Record<string, string>> = {
	JP: " ",
	CN: "",
	TW: "",
	KR: " ",
	// Written in Han script the same way CN and TW are; {@link lineJoinForCountry} asks
	// which script first because Hong Kong's country answer is its English register.
	HK: "",
	MO: "",
	KP: " ",
}

/**
 * Whether the country named by `countryCode` prints the largest unit first, in `script`.
 *
 * Every country carrying a distinct Latin order writes it smallest-first,
 * read off the layout rather than encoded as a rule.
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
 * Which order a layout actually prints: `true` when its `region` line precedes its
 * street line, or `null` when the layout names no region or no street.
 *
 * A layout and {@link isLargestFirstSystem} can disagree, in which case an address
 * prints one system's sequence with another's separators; `layouts.test.ts`
 * compares the two for every country that has both.
 */
export function layoutPrintsLargestFirst(layout: AddressLayout): boolean | null {
	const tags = printedTags(layout)

	const regionAt = tags.indexOf("region")
	const streetAt = tags.findIndex((tag) => tag === "street" || tag === "house_number")

	if (regionAt === -1 || streetAt === -1) return null

	return regionAt < streetAt
}

/**
 * Every slot a layout prints, in print order, flattened across lines
 * rather than per line, because the CJK systems put the whole admin run on one line
 * and a comparison of line indices would read them as unordered.
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
			// An alternation never reorders region against street, so reading the first alternative is enough.
			for (const inner of atom.alternatives) {
				visit(inner)
			}
		}
	}

	visit(layout)

	return tags
}

/**
 * Per-country layouts for the locales this project publishes weights for: each is the
 * country's libaddressinput `fmt` skeleton with `%A` expanded, and the `fmt` is quoted
 * beside it so the two can be compared without opening the dataset.
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

	// %N%n%O%n%A%n%C%n%Z — the postcode takes its own line down the page and a space on one line;
	// the soft break is how one layout says both, keeping `27 Minories, London EC3N 1DE`.
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

	// 〒%Z%n%S%n%A%n%O%n%N, with the prefecture joined to the run below it: written on one line the whole
	// admin run is unseparated and only the postal code takes a space (`〒100-0005 東京都千代田区丸の内1-9-1`).
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

	// %S%n%C%n%A%n%O%n%N — this table holds one layout per country and Hong Kong writes
	// both orders, so it holds the Latin one (`21 Jordan Road, Yau Tsim Mong, Kowloon`),
	// which is what `isLargestFirstSystem("HK") === false` already asserts.
	// No postcode line: Hong Kong operates none.
	HK: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${region}
${country}`,
}

/**
 * Address systems that print the largest unit first, derived from the layouts
 * rather than listed because the layout is the statement of print order.
 *
 * A caller composing its own order — a gazetteer hierarchy string, which is a query
 * rather than an address — reads this instead of re-deriving it.
 * The 122 of the 197 layouts that name no region or no street are absent here
 * and a caller treats them as small-first.
 */
export const LARGEST_FIRST_SYSTEMS: ReadonlySet<string> = new Set(
	Object.entries({ ...GENERATED_ADDRESS_LAYOUTS, ...ADDRESS_LAYOUTS })
		.filter(([, layout]) => layoutPrintsLargestFirst(layout) === true)
		.map(([countryCode]) => countryCode)
)

/**
 * The layout for `country`, or null when neither table names it: the hand-authored
 * entries take precedence because those are checked against real addresses, and null is
 * a real answer for the 55 of 252 shipped records that carry no usable `fmt`.
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

	// A hand-authored entry states one order and may be stating either, so the two
	// print orders decide: agreeing means the board-checked entry is the local order
	// and wins, disagreeing means the `fmt`-derived skeleton is.
	if (script === "local" && hand && local && layoutPrintsLargestFirst(hand) !== layoutPrintsLargestFirst(local)) {
		return local
	}

	return hand ?? GENERATED_ADDRESS_LAYOUTS[code] ?? null
}

/**
 * How the country named by `countryCode` joins its lines for single-line output,
 * in `script`; the CJK joins belong to the local script alone, and asking for a
 * script keeps the order and the separator naming one system.
 */
export function lineJoinForCountry(countryCode: string | null | undefined, script?: AddressScript): string {
	if (!countryCode) return ", "

	const code = countryCode.trim().toUpperCase()

	if ((script ?? defaultScriptForCountry(code)) === "latin") return ", "

	return LINE_JOINS[code] ?? ", "
}

/**
 * Which script {@link layoutForCountry} answers in when no caller says:
 * `local` everywhere except a country whose default layout prints the other order
 * from its own script's skeleton, which is Hong Kong.
 */
export function defaultScriptForCountry(countryCode: string): AddressScript {
	const code = countryCode.trim().toUpperCase()
	const local = GENERATED_LOCAL_ADDRESS_LAYOUTS[code]
	const chosen = ADDRESS_LAYOUTS[code] ?? GENERATED_ADDRESS_LAYOUTS[code]

	if (!local || !chosen) return "local"

	return layoutPrintsLargestFirst(chosen) === layoutPrintsLargestFirst(local) ? "local" : "latin"
}
