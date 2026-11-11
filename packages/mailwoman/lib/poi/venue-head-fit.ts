/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compares a POI row's category with the category a venue name's last word states.
 */

import { getPOICategory, lookupPOICategory } from "@mailwoman/poi-taxonomy"

/**
 * Returns whether a word is a POI category, as `Airport` is and `London` isn't.
 */
export function isVenueCategoryWord(word: string): boolean {
	return lookupPOICategory(word).length > 0
}

/**
 * Returns whether a POI row's category agrees with the last word of the name that found it.
 *
 * A name whose last word is a category, such as `Airport` in `JFK Airport`,
 * states what the place is, so a row filed as a locksmith cannot answer it.
 * A row filed under a narrower category passes: `airport_terminal` sits under `airport`.
 *
 * Every row passes for a name whose last word is no category, such as `Building`.
 */
export function rowFitsVenueHead(name: string, categoryID: string | null): boolean {
	const head = name.trim().split(/\s+/u).at(-1)

	if (!head) return true

	const stated = lookupPOICategory(head)[0]?.category

	if (!stated) return true

	if (!categoryID) return false

	return getPOICategory(categoryID)?.hierarchy.includes(stated.id) ?? false
}
