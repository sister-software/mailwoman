/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The resolver's address-point tier, answered from an address layer's `lookup.db` through `AddressKeyLookup`.
 */

import type { AddressPointHit, AddressPointLookup } from "@mailwoman/core/resolver"

import {
	type AddressKeyHit,
	AddressKeyLevel,
	AddressKeyLookup,
	type AddressStatementRunner,
} from "#address/keys/lookup"

interface Bounds {
	minLat: number
	maxLat: number
	minLon: number
	maxLon: number
}

function contains(bounds: Bounds, hit: AddressKeyHit): boolean {
	return hit.lat >= bounds.minLat && hit.lat <= bounds.maxLat && hit.lon >= bounds.minLon && hit.lon <= bounds.maxLon
}

/**
 * An {@link AddressPointLookup} over one region's `lookup.db`.
 *
 * A postcode, locality or subregion key answers with its first row.
 * A region key matches a street and number anywhere in the file, so it answers
 * only inside the box the resolver passes around the resolved locality, and only
 * when the parse stated no postcode or locality to match.
 *
 * With no box it does not answer, as the `address_point` reader did not.
 */
export class AddressKeyPointLookup implements AddressPointLookup {
	readonly #runner: AddressStatementRunner
	readonly #lookup: AddressKeyLookup
	#sources: Promise<Map<number, string>> | null = null
	#release: Promise<string> | null = null

	constructor(runner: AddressStatementRunner, options: { country: string }) {
		this.#runner = runner
		this.#lookup = new AddressKeyLookup(runner, { country: options.country })
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
					? answer.hits.find((candidate) => contains(query.bbox!, candidate))
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

	#sourceNames(): Promise<Map<number, string>> {
		this.#sources ??= this.#runner
			.query<{ source_id: number; name: string }>("SELECT source_id, name FROM source", [])
			.then((rows) => new Map(rows.map((row) => [Number(row.source_id), String(row.name)])))

		return this.#sources
	}

	#releaseVersion(): Promise<string> {
		this.#release ??= this.#runner
			.query<{ version: string }>("SELECT version FROM layer_manifest LIMIT 1", [])
			.then((rows) => {
				const version = rows[0]?.version

				if (!version) throw new Error("lookup.db holds no layer_manifest version")

				return String(version)
			})

		return this.#release
	}
}
