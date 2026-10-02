/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The errors an adapter raises for a caller's own input.
 */

/**
 * Raised when a caller asks for a country outside the set the adapter's source publishes.
 *
 * An adapter whose source spans several jurisdictions checks `opts.country` against its own set,
 * so a caller reads which jurisdictions the source publishes instead of receiving zero rows.
 */
export class UnsupportedCountryError extends Error {
	constructor(adapterID: string, covered: readonly string[], requested: string) {
		super(`${adapterID} adapter: the dataset covers ${covered.join(", ")}, got country=${requested}`)

		this.name = "UnsupportedCountryError"
	}
}
