/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Search over the pipeline's ancestrie artifact: one prefix walk over the feature names, tokenized by the same
 *   function the build used, so a query and an entry never disagree on what a token is. The artifact is one fetch
 *   at startup; every query after that is local.
 */

import { Ancestrie } from "@mailwoman/ancestrie"
import { autocomplete } from "@mailwoman/ancestrie/autocomplete"
import { nomenclatureTokens } from "@mailwoman/astrogeology/search/tokens"
import { z } from "zod"

/**
 * What a hit carries: enough to place and name the feature without a second lookup.
 */
export interface SearchHit {
	id: string
	name: string
	featureType: string
	centerLon: number
	centerLat: number
}

/**
 * The payload the build wrote beside every entry. Read through the schema rather than cast, so an artifact from a build
 * with a different payload fails at load, not as `undefined` in the panel.
 */
const SearchPayloadSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	featureType: z.string().min(1),
	centerLon: z.number(),
	centerLat: z.number(),
})

const DEFAULT_LIMIT = 8

/**
 * The BFS collects more than it answers so the rank-descending sort has real choices; a name and its alias both match a
 * shared prefix and collapse to one hit, which is why the surplus is needed.
 */
const CANDIDATE_MULTIPLIER = 3

/**
 * How many tokens past the typed prefix a suggestion may run. A nomenclature name is at most a few words (`Marco Polo
 * P`, `Mare Tranquillitatis`), so a first-token prefix must reach the whole name.
 */
const MAX_EXPANSION_DEPTH = 6

export class PlanetarySearch {
	readonly #trie: Ancestrie

	constructor(trie: Ancestrie) {
		this.#trie = trie
	}

	/**
	 * Prefix search: the largest feature first at a shared prefix, one hit per feature however many of its surfaces
	 * match.
	 */
	query(text: string, limit = DEFAULT_LIMIT): SearchHit[] {
		const tokens = nomenclatureTokens(text)

		if (!tokens.length) return []

		const result = autocomplete(this.#trie, tokens, {
			maxSuggestions: limit * CANDIDATE_MULTIPLIER,
			maxExpansionDepth: MAX_EXPANSION_DEPTH,
		})

		const hits: SearchHit[] = []
		const seen = new Set<string>()

		for (const suggestion of result.suggestions) {
			const payload = SearchPayloadSchema.safeParse(suggestion.payload)

			if (!payload.success || seen.has(payload.data.id)) continue

			seen.add(payload.data.id)
			hits.push(payload.data)

			if (hits.length === limit) break
		}

		return hits
	}

	/**
	 * The feature behind a stable id, or null when the artifact has no entry for it.
	 */
	byID(id: string): SearchHit | null {
		const entryID = Number(id)

		if (!Number.isInteger(entryID)) return null

		const payload = SearchPayloadSchema.safeParse(this.#trie.getEntry(entryID)?.payload)

		return payload.success ? payload.data : null
	}
}

export interface LoadSearchIndexOptions {
	/**
	 * How the artifact's bytes are read. `fetch` by default; a test reads a fixture from disk.
	 */
	readBytes?: (url: string) => Promise<Uint8Array>
}

/**
 * Fetch the artifact and open it. Throws on a failed fetch or bytes that are not a sealed ancestrie, so a wrong version
 * pin fails at startup rather than answering nothing to every query.
 */
export async function loadSearchIndex(url: string, options: LoadSearchIndexOptions = {}): Promise<PlanetarySearch> {
	let bytes: Uint8Array

	if (options.readBytes) {
		bytes = await options.readBytes(url)
	} else {
		const response = await fetch(url)

		if (!response.ok) {
			throw new Error(`${url}: ${response.status} ${response.statusText}`)
		}

		bytes = new Uint8Array(await response.arrayBuffer())
	}

	return new PlanetarySearch(Ancestrie.from(bytes))
}
