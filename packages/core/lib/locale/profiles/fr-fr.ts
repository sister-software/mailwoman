// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Fr-FR locale profile. Extends the en-US component set with cedex (postal routing),
 *   street_prefix_particle (de la / du / des), and dependent_locality (arrondissement).
 */

import type { LocaleProfile } from "#locale/locale"

/**
 * French locale profile.
 */
export const frFR: LocaleProfile = {
	locale: "fr-FR",
	componentsSupported: [
		"country",
		"region",
		"locality",
		"postcode",
		"house_number",
		"street",
		"street_prefix",
		"street_prefix_particle",
		"street_suffix",
		"unit",
		"venue",
		"attention",
		"po_box",
		"intersection_a",
		"intersection_b",
		"cedex",
		"dependent_locality",
	],
	policy: [],
}
