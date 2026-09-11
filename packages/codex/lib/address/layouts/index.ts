/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The per-country layout table. Each entry reads in the order it prints, so checking a country means looking at the
 *   shape of an address from there rather than at a nested call.
 *
 *   THE LINE SKELETONS COME FROM libaddressinput, Google's address metadata, which this repository already ships at
 *   `packages/core/data/chromium-i18n/ssl-address/` (252 countries, Apache-2.0) and already has a refresh command for
 *   (`mailwoman dev download ssl-address`). Its `fmt` field is the print order — `%N%n%O%n%A%n%C, %S %Z` for the United
 *   States — and it carries the two things the OpenStreetMap-derived templates get wrong for the locales this project
 *   publishes weights for: Japan's postal mark and largest-first order, and China's unseparated admin run.
 *
 *   WHAT THE DATASET DOES NOT CARRY, and what is therefore authored here:
 *
 *   1. **The `%A` expansion.** libaddressinput models the street address as ONE opaque field, because its consumers
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
 *   4. **The post-office box.** The dataset models no box at all; the street node carries it, on its own line directly
 *      above the street.
 *
 *   Adding a country is therefore: transcribe its `fmt` skeleton, pick a street node, and close with the country line.
 *   A country whose real convention departs from the skeleton says so in place, with its source.
 */

import {
	addr,
	numberFirstCommaStreet,
	numberFirstStreet,
	numberLastCommaStreet,
	numberLastStreet,
	SLOTS,
	type AddressLayout,
} from "#address/layout"
import { GENERATED_ADDRESS_LAYOUTS } from "#address/layouts/generated"

const { attention, venue, house_number, street, dependent_locality, locality, subregion, region, postcode, country } =
	SLOTS

/**
 * The admin run below the prefecture in Japan, printed without separators. Japan's `fmt` carries no `%C` or `%D`, so
 * everything below the prefecture rides the street-address field.
 */
export const japaneseSubPrefecture = addr`${subregion}${locality}${dependent_locality}${house_number}`

/**
 * China's street line: the name then the number, unseparated, below an admin run its `fmt` prints as `%S%C%D`.
 */
export const chineseStreet = addr`${street}${house_number}`

/**
 * How a system joins its lines for SINGLE-LINE output. Absent reads as `", "`, the anglophone default.
 *
 * The CJK entries are the reason this is per-system rather than a caller's argument: joining Japan's lines with a comma
 * produces `1-9-1, 丸の内, 千代田区, 東京都 100-0005`, which is the romanized convention printed backwards.
 */
export const LINE_JOINS: Readonly<Record<string, string>> = {
	JP: " ",
	CN: "",
	TW: "",
	KR: " ",
}

/**
 * Address systems that print the largest unit first.
 *
 * It is a property of the system, not of the layout table, so a caller composing its own order — a gazetteer hierarchy
 * string, say, which is a query rather than an address — reads it here instead of re-deriving it.
 */
export const LARGEST_FIRST_SYSTEMS: ReadonlySet<string> = new Set(["JP", "CN", "TW", "KR"])

/**
 * Whether the country named by `countryCode` prints the largest unit first.
 */
export function isLargestFirstSystem(countryCode: string | null | undefined): boolean {
	if (!countryCode) return false

	return LARGEST_FIRST_SYSTEMS.has(countryCode.trim().toUpperCase())
}

/**
 * Per-country layouts for the locales this project publishes weights for.
 *
 * Each is the country's libaddressinput `fmt` skeleton with `%A` expanded. The `fmt` is quoted beside it so the two can
 * be compared without opening the dataset.
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

	// %N%n%O%n%A%n%C%n%Z
	GB: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${postcode}
${country}`,

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
	// The dataset breaks the line between %S and %A because an envelope prints them on separate lines. Written on ONE
	// line — which is what a geocoder query and a corpus row are — the whole admin run is unseparated and only the
	// postal code takes a space: `〒100-0005 東京都千代田区丸の内1-9-1`. Keeping the dataset's break would put a space
	// after the prefecture, which no Japanese address carries.
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
}

/**
 * The layout for `country`, or null when neither table names it.
 *
 * The hand-authored entries win: those are checked against real addresses on a board, where a generated skeleton is a
 * transcription of a dataset. Null is a real answer — 55 of the 252 shipped country records carry no usable `fmt`, and
 * a caller that renders nothing for one of those is reporting absence rather than inventing an order.
 */
export function layoutForCountry(countryCode: string | null | undefined): AddressLayout | null {
	if (!countryCode) return null

	const code = countryCode.trim().toUpperCase()

	return ADDRESS_LAYOUTS[code] ?? GENERATED_ADDRESS_LAYOUTS[code] ?? null
}

/**
 * How the country named by `countryCode` joins its lines for single-line output.
 */
export function lineJoinForCountry(countryCode: string | null | undefined): string {
	if (!countryCode) return ", "

	return LINE_JOINS[countryCode.trim().toUpperCase()] ?? ", "
}
