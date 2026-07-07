/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node reader over the POSTAL-CITY ALIAS table (`postal-city-alias-<cc>.db`) — the observed
 *   `postal_city → geo_locality` aliases per postcode (`build-postal-city-alias.ts`). Consumed by
 *   {@link WOFSqlitePlaceLookup}'s coordinate-first locality scorer: a user-typed postal city
 *   ("Antioch", postcode 37013) becomes a name-match alias for the geographic locality the postcode
 *   actually sits in ("Nashville"), so the right place tiers to the top instead of a same-named
 *   town in another state. Opt-in — the lookup is only constructed when a path is supplied, and
 *   absent it the resolver is byte-identical.
 *
 *   The reader returns RAW divergent rows for a postcode; normalization + name-matching against the
 *   candidate localities is the scorer's job (it owns the case/diacritic fold the soft name score
 *   uses), keeping one normalizer in one place.
 */

import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"

import type { PostalCityAliasDatabase } from "./postal-city-alias-schema.js"

export interface WOFPostalCityAliasLookupOpts {
	/** Path to a `postal-city-alias-<cc>.db` built by `build-postal-city-alias.ts`. Opened read-only. */
	databasePath?: string
	/** Pre-opened handle (tests / shared connections). Mutually exclusive with `databasePath`. */
	database?: DatabaseSync
}

/** One divergent alias edge: the postal-system name and the geographic locality it maps to. */
export interface PostalCityAlias {
	/** The postal-system surface (what a user types). */
	postalCity: string
	/** The geographic locality name the postcode sits in (≈ the gazetteer's canonical name). */
	geoLocality: string
	/** Observed usage count — the evidence weight. */
	n: number
}

/**
 * Reader over `postal_city_alias`. The only query is a postcode-scoped probe for DIVERGENT rows (where the postal name
 * differs from the geographic name — the rows that carry alias signal), issued via the typed Kysely query builder
 * against {@link PostalCityAliasDatabase}.
 */
export class WOFPostalCityAliasLookup {
	#db: DatabaseSync
	#kdb: DatabaseClient<PostalCityAliasDatabase>
	#ownsDB: boolean

	constructor(opts: WOFPostalCityAliasLookupOpts) {
		if (opts.database) {
			this.#db = opts.database
			this.#ownsDB = false
		} else if (opts.databasePath) {
			this.#db = new DatabaseSync(opts.databasePath, { readOnly: true })
			this.#ownsDB = true
		} else {
			throw new Error("WOFPostalCityAliasLookup needs `databasePath` or `database`")
		}
		// `#kdb` wraps `#db` for the typed query; close() owns the raw handle directly (sync).
		this.#kdb = new DatabaseClient<PostalCityAliasDatabase>({ database: this.#db })
	}

	/**
	 * Divergent postal-city aliases for a postcode (empty when the postcode isn't in the table). The scorer groups these
	 * by normalized `geoLocality` and appends the `postalCity` surfaces to the matching candidate locality's alias set.
	 */
	async getDivergentAliases(postcode: string): Promise<PostalCityAlias[]> {
		const pc = postcode.trim()

		if (!pc) return []
		const rows = await this.#kdb
			.selectFrom("postal_city_alias")
			.select(["postal_city", "geo_locality", "n"])
			.where("postcode", "=", pc)
			.where("divergent", "=", 1)
			.execute()

		return rows.map((r) => ({ postalCity: String(r.postal_city), geoLocality: String(r.geo_locality), n: Number(r.n) }))
	}

	close(): void {
		if (this.#ownsDB) {
			this.#db.close()
		}
	}
}
