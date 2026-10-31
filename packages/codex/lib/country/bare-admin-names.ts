/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The bare form of an admin-area name, per country, for countries whose names include a unit suffix.
 */

import { stripAdminSuffix } from "#jp/address-unit"

/**
 * Returns the name a place is written under without its admin-unit suffix, keyed by ISO 3166-1 alpha-2.
 *
 * A Japanese address may omit a ward, city or prefecture suffix: `渋谷` for `渋谷区`, `東京` for `東京都`.
 * A country is listed here only when its names include the suffix as a separate written unit.
 * A country absent from the table has no bare form.
 */
export const BARE_ADMIN_NAME: Readonly<Record<string, (name: string) => string>> = {
	JP: stripAdminSuffix,
}

/**
 * The fewest characters a bare name may keep.
 *
 * A one-character remainder, such as `港` from `港区`, can be the ordinary word for port rather than a place.
 */
export const BARE_ADMIN_NAME_MIN_LENGTH = 2

/**
 * The bare form of `name` in `country`, or `null` when the country has no bare form
 * or the name keeps its suffix.
 */
export function bareAdminName(country: string, name: string): string | null {
	const bare = BARE_ADMIN_NAME[country.toUpperCase()]?.(name)

	if (!bare || bare === name || [...bare].length < BARE_ADMIN_NAME_MIN_LENGTH) return null

	return bare
}
