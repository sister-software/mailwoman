/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads an address layer's `lookup.db` by the levels a parse resolved, for the CLI, the Workers and the browser.
 *
 *   The reader runs its statements through an {@link AddressStatementRunner}. A local `DatabaseClient` and the
 *   browser's range-request database both satisfy it, so the three runtimes share one read order.
 */

import { addressPostcodeKey } from "#address/keys/postcode"
import { houseNumberForms } from "#address/number-forms"
import { streetLocaleForCountry } from "#street/locale"
import {
	normalizeHouseNumberForKey,
	normalizeLocalityForKey,
	type StreetLocale,
	streetKeyVariants,
	streetLocaleForSurface,
} from "#street/normalize"

/**
 * The one capability the reader needs from a database: run a parameterized `SELECT` and return its rows.
 */
export interface AddressStatementRunner {
	query<Row>(sql: string, parameters: readonly (string | number)[]): Promise<Row[]>
}

/**
 * The key level a lookup answered at.
 */
export const AddressKeyLevel = {
	Postcode: "postcode",
	Locality: "locality",
	Subregion: "subregion",
	Region: "region",
} as const

export type AddressKeyLevel = (typeof AddressKeyLevel)[keyof typeof AddressKeyLevel]

/**
 * One point a key answered with.
 */
export interface AddressKeyHit {
	lat: number
	lon: number
	addressID: number
	sourceID: number
	level: AddressKeyLevel
}

/**
 * What a parse resolved, in the encoder's terms.
 */
export interface AddressKeyQuery {
	street: string
	number: string
	postcode?: string | null
	/**
	 * Every locality and dependent-locality name the parse states, in the order the reader tries them.
	 */
	localities?: readonly string[]
	subregion?: string | null
}

/**
 * The rows the first answering level returned, at most {@link AddressKeyLookupOptions.rowCap}, with the level.
 *
 * Several rows mean namesake points under one key: two sources for one address,
 * or one street and number repeated within the scope.
 * The caller ranks them.
 */
export interface AddressKeyAnswer {
	level: AddressKeyLevel
	hits: AddressKeyHit[]
}

export interface AddressKeyLookupOptions {
	/**
	 * The ISO 3166-1 alpha-2 code of the country the file covers.
	 * It selects the street locale and the postcode key.
	 */
	country: string
	/**
	 * The most rows one level returns.
	 *
	 * @defaultValue 8
	 */
	rowCap?: number
}

interface KeyRow {
	lat: number
	lon: number
	address_id: number
	source_id: number
}

const SELECT_SCOPED = (table: string, cap: number) =>
	`SELECT lat, lon, address_id, source_id FROM ${table} WHERE scope = ? AND street = ? AND number = ? LIMIT ${cap}`

/**
 * Finds address points by the most precise level a parse states: postcode,
 * then each locality name, then the subregion, then the file's whole region.
 *
 * The first level with a row answers.
 * A level the parse leaves empty is skipped, so a parse that states a street
 * and number and no place reads only the region key.
 */
export class AddressKeyLookup {
	readonly #runner: AddressStatementRunner
	readonly #country: string
	readonly #locale: StreetLocale
	readonly #cap: number

	constructor(runner: AddressStatementRunner, options: AddressKeyLookupOptions) {
		this.#runner = runner
		this.#country = options.country.toUpperCase()
		this.#locale = streetLocaleForCountry(options.country)
		this.#cap = options.rowCap ?? 8
	}

	/**
	 * The first level's rows, or `null` when no level holds the street and number.
	 */
	async find(query: AddressKeyQuery): Promise<AddressKeyAnswer | null> {
		const number = query.number.trim() ? normalizeHouseNumberForKey(query.number, this.#locale) : ""

		if (!number) return null

		// Every street variant runs every number form, and every form runs the level ladder,
		// so the literal street and written number answer first.
		for (const street of streetKeyVariants(query.street, streetLocaleForSurface(query.street, this.#locale))) {
			if (!street) continue

			for (const form of houseNumberForms(number, this.#locale)) {
				const answer = await this.#ladder(query, street, form)

				if (answer) return answer
			}
		}

		return null
	}

	async #ladder(query: AddressKeyQuery, street: string, number: string): Promise<AddressKeyAnswer | null> {
		const postcode = addressPostcodeKey(this.#country, query.postcode)

		if (postcode) {
			const hits = await this.#scoped("key_postcode", AddressKeyLevel.Postcode, postcode, street, number)

			if (hits.length) return { level: AddressKeyLevel.Postcode, hits }
		}

		for (const locality of query.localities ?? []) {
			const key = normalizeLocalityForKey(locality)

			if (!key) continue
			const hits = await this.#scoped("key_locality", AddressKeyLevel.Locality, key, street, number)

			if (hits.length) return { level: AddressKeyLevel.Locality, hits }
		}

		const subregion = query.subregion?.trim() ? normalizeLocalityForKey(query.subregion) : ""

		if (subregion) {
			const hits = await this.#scoped("key_subregion", AddressKeyLevel.Subregion, subregion, street, number)

			if (hits.length) return { level: AddressKeyLevel.Subregion, hits }
		}

		const rows = await this.#runner.query<KeyRow>(
			`SELECT lat, lon, address_id, source_id FROM key_region WHERE street = ? AND number = ? LIMIT ${this.#cap}`,
			[street, number]
		)

		return rows.length
			? { level: AddressKeyLevel.Region, hits: rows.map((row) => toHit(row, AddressKeyLevel.Region)) }
			: null
	}

	async #scoped(
		table: "key_postcode" | "key_locality" | "key_subregion",
		level: AddressKeyLevel,
		scope: string,
		street: string,
		number: string
	): Promise<AddressKeyHit[]> {
		const rows = await this.#runner.query<KeyRow>(SELECT_SCOPED(table, this.#cap), [scope, street, number])

		return rows.map((row) => toHit(row, level))
	}
}

function toHit(row: KeyRow, level: AddressKeyLevel): AddressKeyHit {
	return {
		lat: Number(row.lat),
		lon: Number(row.lon),
		addressID: Number(row.address_id),
		sourceID: Number(row.source_id),
		level,
	}
}
