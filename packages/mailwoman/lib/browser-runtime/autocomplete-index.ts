/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The place autocomplete index a page reads without the engine: one sealed `@mailwoman/ancestrie` per leading
 *   character of the folded place name, published under `autocomplete/<generation>/` beside a manifest that lists
 *   the files. A query folds the typed text with the same function the index was keyed with, fetches the one file
 *   its first token selects, and walks it. The home page's hero is the first reader.
 */

import { Ancestrie, autocomplete } from "@mailwoman/ancestrie"
import { isPresent } from "@mailwoman/core/objects"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { z } from "zod"

import { fetchWithRetry } from "#browser-runtime/fetch"
import { autocompleteIndexManifestURL, autocompleteIndexURL } from "#browser-runtime/resources"

/**
 * The payload stored beside every entry, with one-letter keys because every entry of a file repeats them.
 */
export const PlaceSuggestionPayloadSchema = z.object({
	/**
	 * The place id, a Who's On First id or an Overture-minted one.
	 *
	 * It sits in the payload because an Overture-minted id exceeds the 32-bit entry id a trie allows.
	 */
	i: z.number(),
	/**
	 * The place's display name.
	 */
	n: z.string().min(1),
	/**
	 * The Who's On First placetype.
	 */
	t: z.string().min(1),
	/**
	 * The ISO alpha-2 country code.
	 */
	c: z.string(),
	/**
	 * Latitude.
	 */
	y: z.number(),
	/**
	 * Longitude.
	 */
	x: z.number(),
	/**
	 * The parent chain, nearest first, joined by a comma and a space.
	 * Empty for a country.
	 */
	p: z.string(),
})

export type PlaceSuggestionPayload = z.infer<typeof PlaceSuggestionPayloadSchema>

/**
 * One completed place, with what a search box needs to show it and hand it on.
 */
export interface PlaceSuggestion {
	/**
	 * The place id, a Who's On First id or an Overture-minted one.
	 */
	id: number
	name: string
	placetype: string
	country: string
	latitude: number
	longitude: number
	/**
	 * The parent chain, nearest first, as one comma-joined string.
	 */
	parents: string
	/**
	 * The resolver's rank for the place, higher first.
	 */
	rank: number
}

/**
 * What one generation holds, as `index.json` records it.
 */
export interface AutocompleteIndexManifest {
	version: string
	/**
	 * The population floor a place needed to enter the index.
	 * Countries and regions enter regardless.
	 */
	floor: number
	entries: number
	/**
	 * Per partition file, its entries and its byte length before encoding.
	 */
	files: Record<string, { entries: number; bytes: number }>
}

const DEFAULT_LIMIT = 8

/**
 * The BFS collects three times the limit, so the rank-descending order has choices after the dedupe by id.
 */
const CANDIDATE_MULTIPLIER = 3

/**
 * The count of tokens past the typed prefix a suggestion may run, enough for a several-word place name.
 */
const MAX_EXPANSION_DEPTH = 4

/**
 * The tokens of a place name as the index keys them: the shared locality fold, split on spaces.
 *
 * The builder and the query both call this, so a query and an entry never disagree on what a token is.
 */
export function autocompleteTokens(text: string): string[] {
	return String(normalizeLocalityForKey(text)).split(" ").filter(isPresent)
}

/**
 * The partition file a first token is filed under.
 *
 * A Latin letter is its own file and the ten digits share one, because the fold
 * leaves Latin names in lowercase ASCII.
 * Any other leading character, such as a Cyrillic or Han letter, is filed by its 256-code-point
 * block in hex, so a script's names sit together without one file per character.
 */
export function autocompletePartitionOf(firstToken: string): string {
	const first = firstToken.codePointAt(0)

	if (first === undefined) return "_"

	if (first >= 0x30 && first <= 0x39) return "0"

	if (first >= 0x61 && first <= 0x7a) return String.fromCodePoint(first)

	return `u${(first >> 8).toString(16).padStart(2, "0")}`
}

/**
 * A query interface over one generation of the index, loading each partition file once on first use.
 */
export class PlaceAutocompleteIndex {
	readonly #manifest: () => Promise<AutocompleteIndexManifest>
	readonly #load: (partition: string) => Promise<Ancestrie>
	readonly #files = new Map<string, Promise<Ancestrie>>()

	/**
	 * @param manifest Reads the generation's manifest.
	 * Called once.
	 * @param load Reads one partition file into a trie.
	 * Called once per partition.
	 */
	constructor(manifest: () => Promise<AutocompleteIndexManifest>, load: (partition: string) => Promise<Ancestrie>) {
		let pending: Promise<AutocompleteIndexManifest> | null = null

		this.#manifest = () => (pending ??= manifest())
		this.#load = load
	}

	/**
	 * The places whose folded name starts with the typed text, strongest first, one per place.
	 *
	 * Text whose first token selects a partition the generation holds no file for answers an empty list.
	 */
	async query(text: string, limit = DEFAULT_LIMIT): Promise<PlaceSuggestion[]> {
		const tokens = autocompleteTokens(text)

		if (!tokens.length) return []

		const partition = autocompletePartitionOf(tokens[0]!)
		const manifest = await this.#manifest()

		if (!(partition in manifest.files)) return []

		const trie = await this.#file(partition)

		const result = autocomplete(trie, tokens, {
			maxSuggestions: limit * CANDIDATE_MULTIPLIER,
			maxExpansionDepth: MAX_EXPANSION_DEPTH,
			dedupe: (suggestion) => String(suggestion.id),
		})

		const out: PlaceSuggestion[] = []

		for (const suggestion of result.suggestions) {
			const payload = PlaceSuggestionPayloadSchema.safeParse(suggestion.payload)

			if (!payload.success) continue

			out.push({
				id: payload.data.i,
				rank: suggestion.rank,
				name: payload.data.n,
				placetype: payload.data.t,
				country: payload.data.c,
				latitude: payload.data.y,
				longitude: payload.data.x,
				parents: payload.data.p,
			})

			if (out.length === limit) break
		}

		return out
	}

	#file(partition: string): Promise<Ancestrie> {
		let loading = this.#files.get(partition)

		if (!loading) {
			loading = this.#load(partition)
			this.#files.set(partition, loading)
		}

		return loading
	}
}

/**
 * Reads one published partition file into a trie.
 *
 * @throws On a failed fetch or bytes that are not a sealed ancestrie, so a wrong version
 * pin fails on the first query rather than answering no suggestion to every query.
 */
export async function fetchAutocompletePartition(url: string): Promise<Ancestrie> {
	const response = await fetchWithRetry(url)

	if (!response.ok) {
		throw new Error(`autocomplete index: ${url} answered ${response.status}`)
	}

	return Ancestrie.from(new Uint8Array(await response.arrayBuffer()))
}

/**
 * Reads the published generation's manifest.
 */
export async function fetchAutocompleteManifest(url: string): Promise<AutocompleteIndexManifest> {
	const response = await fetchWithRetry(url)

	if (!response.ok) {
		throw new Error(`autocomplete index: ${url} answered ${response.status}`)
	}

	return (await response.json()) as AutocompleteIndexManifest
}

/**
 * The index over the published generation `AUTOCOMPLETE_INDEX_VERSION`.
 */
export function openPlaceAutocompleteIndex(): PlaceAutocompleteIndex {
	return new PlaceAutocompleteIndex(
		() => fetchAutocompleteManifest(autocompleteIndexManifestURL()),
		(partition) => fetchAutocompletePartition(autocompleteIndexURL(partition))
	)
}

/**
 * The one-line label a suggestion shows beside its name: the placetype, then the parent chain.
 *
 * A place whose gazetteer row lists no region or country above it, as London's does,
 * shows its country code in the chain's place.
 * A country shows its placetype by itself.
 */
export function suggestionDetail(suggestion: PlaceSuggestion): string {
	if (suggestion.parents) return `${suggestion.placetype} · ${suggestion.parents}`

	return suggestion.placetype === "country" ? suggestion.placetype : `${suggestion.placetype} · ${suggestion.country}`
}
