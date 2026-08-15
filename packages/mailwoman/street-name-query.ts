/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Recognise a parse that read its WHOLE input as a street name, which the alternate-register retry treats as
 *   already-final. See {@link isStreetNameQuery}.
 */

import type { ComponentTag } from "@mailwoman/core"

/**
 * Tags that can appear in a parse that read its whole input as a street NAME — no number, no locality, no postcode.
 */
const STREET_NAME_ONLY_TAGS = new Set<ComponentTag>(["street", "street_prefix", "street_suffix"])

/**
 * Whether a parse read the entire input as a street name.
 *
 * Such a parse is not a misrouted register, so the alternate-register retry has nothing to re-read: the input IS a
 * street-name query, and a zero hit means the gazetteer has no street coverage there. Retrying anyway lets a
 * single-token homonym INSIDE the street name claim the result and clip the span that was already right — "Sultan
 * Qaboos Street" resolves Sultan, Washington and shortens `street` to "Qaboos".
 *
 * Measured on the regression board: the guard moves `om-street-name-sultan-qaboos-street`,
 * `fr-street-name-rue-du-faubourg-saint-honore` and `us-street-name-ocean-parkway-south` from fail to pass, with and
 * without the gazetteer emission prior, and changes no other row.
 */
export function isStreetNameQuery(components: Partial<Record<ComponentTag, string>>): boolean {
	const tags = (Object.keys(components) as ComponentTag[]).filter((tag) => components[tag])

	return tags.includes("street") && tags.every((tag) => STREET_NAME_ONLY_TAGS.has(tag))
}
