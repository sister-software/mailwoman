/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node reader over the postal-city alias table (`postal-city-alias-<cc>.db`) — the observed
 *   `postal_city → geo_locality` aliases per postcode (`build-postal-city-alias.ts`). Consumed by
 *   {@link WOFSQLitePlaceLookup}'s coordinate-first locality scorer: a user-typed postal city
 *   ("Antioch", postcode 37013) becomes a name-match alias for the geographic locality the postcode
 *   actually sits in ("Nashville"), so the right place tiers to the top instead of a place with the same name
 *   town in another state. Opt-in — the lookup is only constructed when a path is supplied.
 *   absent it the resolver is byte-identical.
 *
 *   The reader returns RAW divergent rows for a postcode. normalization + name-matching against the
 *   candidate localities is the scorer's job (it owns the case/diacritic fold the soft name score
 *   uses), keeping one normalizer in one place.
 */

import { SQLiteLookup, type SQLiteLookupOptions } from "@mailwoman/sqlite/lookup"

import type { PostalCityAliasDatabase } from "#postal/city/alias/schema"

/**
 * Where a {@link WOFPostalCityAliasLookup} reads from: a `postal-city-alias-<cc>.db` built by
 * `build-postal-city-alias.ts`, opened read-only, or a connection the caller already holds.
 */
export type WOFPostalCityAliasLookupOpts = SQLiteLookupOptions<PostalCityAliasDatabase>

/**
 * One divergent alias edge: the postal-system name and the geographic locality it maps to.
 */
export interface PostalCityAlias {
	/**
	 * The postal-system surface (what a user types).
	 */
	postalCity: string
	/**
	 * The geographic locality name the postcode sits in (≈ the gazetteer's canonical name).
	 */
	geoLocality: string
	/**
	 * Observed usage count — the evidence weight.
	 */
	n: number
}

/**
 * Reader over `postal_city_alias`.
 *
 * The only query is a postcode-scoped probe for divergent rows
 * (where the postal name differs from the geographic name — the rows that provide alias signal),
 * issued via the typed Kysely query builder against {@link PostalCityAliasDatabase}.
 */
export class WOFPostalCityAliasLookup extends SQLiteLookup<PostalCityAliasDatabase> {
	constructor(opts: WOFPostalCityAliasLookupOpts) {
		super(opts)
	}

	/**
	 * Divergent postal-city aliases for a postcode (empty when the postcode isn't in the table).
	 *
	 * The scorer groups these by normalized `geoLocality` and appends the `postalCity`
	 * surfaces to the matching candidate locality's alias set.
	 */
	async getDivergentAliases(postcode: string): Promise<PostalCityAlias[]> {
		const pc = postcode.trim()

		if (!pc) return []

		const rows = await this.database
			.selectFrom("postal_city_alias")
			.select(["postal_city", "geo_locality", "n"])
			.where("postcode", "=", pc)
			.where("divergent", "=", 1)
			.execute()

		return rows.map((r) => ({ postalCity: String(r.postal_city), geoLocality: String(r.geo_locality), n: Number(r.n) }))
	}
}
