// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The resolver's address-point tier, answered from an address layer's
 *   `lookup.db` through `AddressKeyLookup`.
 */

import { parseJSONStrict } from "@mailwoman/core/json"
import { memoizeResettable } from "@mailwoman/core/memoize"
import type { AddressPointHit, AddressPointLookup } from "@mailwoman/core/resolver"
import { type LatLonBounds, latLonBoundsContain } from "@mailwoman/spatial/bbox"

import {
	type AddressKeyHit,
	AddressKeyLevel,
	AddressKeyLookup,
	type AddressStatementRunner,
} from "#address/keys/lookup"

/**
 * An {@link AddressPointLookup} over one region's `lookup.db`.
 *
 * A postcode, locality or subregion key answers with its first row.
 * A region key matches a street and number anywhere in the file.
 *
 * It answers only with a row inside the box the resolver passes around the resolved locality,
 * and only with a row whose record states no postcode and no locality, read from `detail.db`.
 * A row that states either would have matched its own scope, so its place isn't the one the parse states.
 *
 * This is the rule the `address_point` reader applies to its bounding-box scope.
 *
 * With no box, or with no `detail.db` to read, a region key doesn't answer.
 */
export class AddressKeyPointLookup implements AddressPointLookup {
	readonly #runner: AddressStatementRunner
	readonly #detail: AddressStatementRunner | null
	readonly #lookup: AddressKeyLookup

	/**
	 * The `source` table, read once.
	 * A failed read is retried by the next lookup.
	 */
	readonly #sourceNames = memoizeResettable(() =>
		this.#runner
			.query<{ source_id: number; name: string }>("SELECT source_id, name FROM source", [])
			.then((rows) => new Map(rows.map((row) => [Number(row.source_id), String(row.name)])))
	)

	/**
	 * The layer release version, read once.
	 * A failed read is retried by the next lookup.
	 */
	readonly #releaseVersion = memoizeResettable(() =>
		this.#runner.query<{ version: string }>("SELECT version FROM layer_manifest LIMIT 1", []).then((rows) => {
			const version = rows[0]?.version

			if (!version) throw new Error("lookup.db holds no layer_manifest version")

			return String(version)
		})
	)

	constructor(runner: AddressStatementRunner, options: { country: string; detail?: AddressStatementRunner | null }) {
		this.#runner = runner
		this.#detail = options.detail ?? null
		this.#lookup = new AddressKeyLookup(runner, { country: options.country })
	}

	/**
	 * The first region-key row inside `bounds` whose record states no postcode and no locality.
	 */
	async #unscopedInside(hits: readonly AddressKeyHit[], bounds: LatLonBounds): Promise<AddressKeyHit | undefined> {
		if (!this.#detail) return undefined

		for (const candidate of hits) {
			if (!latLonBoundsContain(bounds, candidate.lat, candidate.lon)) continue

			const [row] = await this.#detail.query<{ postcode: string | null; names: string }>(
				"SELECT postcode, names FROM address WHERE address_id = ?",
				[candidate.addressID]
			)

			if (!row) throw new Error(`detail.db holds no address ${candidate.addressID} for a lookup.db key row`)

			const statesLocality = parseJSONStrict<Array<{ level: string }>>(row.names).some(
				(name) => name.level === "locality" || name.level === "dependent_locality"
			)

			if (!row.postcode && !statesLocality) return candidate
		}

		return undefined
	}

	async find(query: Parameters<AddressPointLookup["find"]>[0]): Promise<AddressPointHit | null> {
		const answer = await this.#lookup.find({
			street: query.street,
			number: query.number,
			postcode: query.postcode ?? null,
			localities: query.locality ? [query.locality] : [],
			subregion: query.subregion ?? null,
		})

		if (!answer) return null

		const hit =
			answer.level === AddressKeyLevel.Region
				? query.bbox
					? await this.#unscopedInside(answer.hits, query.bbox)
					: undefined
				: answer.hits[0]

		if (!hit) return null

		const [sources, release] = await Promise.all([this.#sourceNames(), this.#releaseVersion()])
		const source = sources.get(hit.sourceID)

		if (!source) throw new Error(`lookup.db holds a key row of source ${hit.sourceID}, which its source table lacks`)

		return {
			lat: hit.lat,
			lon: hit.lon,
			source,
			release,
			localityNorm: null,
			postcode: answer.level === AddressKeyLevel.Postcode ? (query.postcode?.trim() ?? null) : null,
		}
	}
}
