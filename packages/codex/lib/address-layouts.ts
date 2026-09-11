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
 *   Adding a country is therefore: transcribe its `fmt` skeleton, and pick a street node. A country whose real
 *   convention departs from the skeleton says so in place, with its source.
 */

import { addr, numberFirstStreet, numberLastStreet, SLOTS, type AddressLayout } from "#address-layout"
import { GENERATED_ADDRESS_LAYOUTS } from "#address-layouts-generated"

const { attention, venue, house_number, street, dependent_locality, locality, subregion, region, postcode } = SLOTS

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
${locality}, ${region} ${postcode}`,

	// %O%n%N%n%A%n%Z %C
	FR: addr`${venue}
${attention}
${numberFirstStreet}
${dependent_locality}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%C%n%Z
	GB: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${postcode}`,

	// %N%n%O%n%A%n%Z %C
	DE: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%Z %C %S
	ES: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality} ${region}`,

	// %N%n%O%n%A%n%Z %C %S
	IT: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality} ${region}`,

	// %N%n%O%n%A%n%C %Z%n%S
	IN: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${postcode}
${region}`,

	// %N%n%O%n%A%n%D%n%C %Z
	NZ: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality} ${postcode}`,

	// %O%n%N%n%A%n%C %S %Z
	AU: addr`${venue}
${attention}
${numberFirstStreet}
${locality} ${region} ${postcode}`,

	// 〒%Z%n%S%n%A%n%O%n%N, with the prefecture joined to the run below it.
	//
	// The dataset breaks the line between %S and %A because an envelope prints them on separate lines. Written on ONE
	// line — which is what a geocoder query and a corpus row are — the whole admin run is unseparated and only the
	// postal code takes a space: `〒100-0005 東京都千代田区丸の内1-9-1`. Keeping the dataset's break would put a space
	// after the prefecture, which no Japanese address carries.
	JP: addr`〒${postcode}
${region}${japaneseSubPrefecture}
${venue}
${attention}`,

	// %Z%n%S%C%D%n%A%n%O%n%N — the admin run prints unseparated, which is what `LINE_JOINS.CN` carries.
	CN: addr`${postcode}
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
export function layoutForCountry(country: string | null | undefined): AddressLayout | null {
	if (!country) return null

	const code = country.trim().toUpperCase()

	return ADDRESS_LAYOUTS[code] ?? GENERATED_ADDRESS_LAYOUTS[code] ?? null
}

/**
 * How `country` joins its lines for single-line output.
 */
export function lineJoinForCountry(country: string | null | undefined): string {
	if (!country) return ", "

	return LINE_JOINS[country.trim().toUpperCase()] ?? ", "
}
