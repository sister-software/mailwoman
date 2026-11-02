/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Answers whether a premise register publishes a street name, for the unit splitter.
 */

import { foldStreetSurface, type StreetEvidenceScope, type StreetLocalityEvidence } from "@mailwoman/resolver"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { SQLiteLookup } from "@mailwoman/sqlite/lookup"
import type { PathBuilderLike } from "path-ts"

import type { StreetIndexDatabase } from "#street-index/schema"

/**
 * Opens the index at `databasePath` once per country asked for, or answers `null`
 * for every country when no path is given.
 *
 * Pass the result to `createUnitSplitter` from `#adapters/street-unit`.
 */
export function streetIndexOpener(
	databasePath: PathBuilderLike | null | undefined
): (country: string) => CorpusStreetIndex | null {
	return (country) => (databasePath ? new CorpusStreetIndex(databasePath, country) : null)
}

/**
 * The corpus street index for one country.
 *
 * A probe with a locality first looks for the name in that locality.
 * A miss there falls back to the name anywhere in the country, because sources key
 * one place differently (`NEW YORK` in NPPES, `Manhattan` in TIGER).
 */
export class CorpusStreetIndex extends SQLiteLookup<StreetIndexDatabase> implements StreetLocalityEvidence {
	readonly countries: ReadonlySet<string>
	readonly #country: string
	readonly #byName: ReturnType<DatabaseClient["prepare"]>
	readonly #byNameLocality: ReturnType<DatabaseClient["prepare"]>

	constructor(databasePath: PathBuilderLike, country: string) {
		super({ databasePath })
		this.#country = country.toUpperCase()
		this.countries = new Set([this.#country])
		this.#byName = this.database.prepare("SELECT 1 FROM street_name WHERE country = ? AND name_key = ? LIMIT 1")

		this.#byNameLocality = this.database.prepare(
			"SELECT 1 FROM street_name WHERE country = ? AND name_key = ? AND locality_key = ? LIMIT 1"
		)
	}

	hasStreetName(streetSurface: string, scope?: StreetEvidenceScope): boolean {
		const name = foldStreetSurface(streetSurface)

		if (!name) return false

		if (scope?.locality && this.#byNameLocality.get(this.#country, name, foldStreetSurface(scope.locality))) {
			return true
		}

		return this.#byName.get(this.#country, name) !== undefined
	}
}
