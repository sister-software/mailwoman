// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Latin-script layouts read from a primary document, for countries whose libaddressinput
 * `lfmt` prints a line no example the postal operator prints puts there.
 *
 * `layoutForCountry(code, "latin")` answers an entry here ahead of the generated Latin skeleton.
 * Each entry's citation is in `LATIN_LAYOUT_CITATIONS` (`#address/layouts/citations/latin`).
 */

import { addr, either, SLOTS, type AddressLayout } from "#address/layout"

const { attention, country, dependent_locality, house_number, locality, po_box, postcode, region, subregion } = SLOTS

const { intersection_a, intersection_b, street, street_prefix, street_prefix_particle, street_suffix, unit, venue } =
	SLOTS

/**
 * An intersection, or the number, a comma and the road with every affix a row may label.
 */
const road = either(
	addr`${intersection_a} & ${intersection_b}`,
	addr`${house_number}, ${street_prefix} ${street_prefix_particle} ${street} ${street_suffix}`
)

/**
 * Latin layouts by ISO 3166-1 alpha-2.
 */
export const READ_LATIN_ADDRESS_LAYOUTS: Readonly<Record<string, AddressLayout>> = {
	// Japan Post's UPU description, smallest first: number, comma, neighborhood
	// (`10–23, Mitsugi 1–chome`) / town, comma, prefecture (`Musashi-Murayama-shi, TOKYO`)
	// / postcode / country (`4-3-2, Hakusan` / `Bunkyo-ku, TOKYO` / `112-0001` / `JAPAN`).
	// libaddressinput's `%N%n%O%n%A, %S%n%Z` prints no town.
	// The number line prints no intersection, as the Japanese order prints none.
	JP: addr`${attention}
${venue}
${po_box}
${house_number}, ${street_prefix} ${street_prefix_particle} ${street} ${street_suffix}, ${dependent_locality}
${locality}, ${subregion}, ${region}
${postcode}
${country}`,

	// Korea's S42 template, Latin lines: building and floor or wing and door
	// (`AMOREPACIFIC, 2F`, `101-103`) / number, road, town and district with commas
	// (`2275-12, Dalgubeol-daero, Suseong-gu`) / province and postcode (`Daegu 42000`) /
	// country. libaddressinput's `%N%n%O%n%A%n%D%n%C%n%S%n%Z` prints the number after the road
	// and the district, the province and the postcode on lines of their own.
	KR: addr`${attention}
${po_box}
${venue}, ${unit}
${road}, ${dependent_locality}, ${locality}
${region} ${postcode}
${country}`,
}
