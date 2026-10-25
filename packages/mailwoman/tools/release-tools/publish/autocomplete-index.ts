/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds the place autocomplete index from the candidate gazetteer: the primary-name places above a population
 *   floor, with every country and region regardless of population, written as one sealed ancestrie per leading
 *   character of the folded name under `autocomplete/<generation>/` beside a manifest. The payload of every entry
 *   is what `mailwoman/browser-runtime/autocomplete-index` reads back.
 */

import { AncestrieBuilder, type AncestrieEntry } from "@mailwoman/ancestrie"
import { makeDirectories, writeLocalFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { isoSeconds } from "@mailwoman/core/utils"
import {
	REGION_AND_COARSER_PLACETYPES,
	SUB_LOCALITY_PLACETYPES,
} from "@mailwoman/gazetteer/whosonfirst/placetypes/specificity"
import { openBuiltClient } from "@mailwoman/sqlite/sealed"
import type { PathBuilderLike } from "path-ts"
import { resolvePathBuilder } from "path-ts"

import {
	type AutocompleteIndexManifest,
	autocompletePartitionOf,
	autocompleteTokens,
	type PlaceSuggestionPayload,
} from "#browser-runtime/autocomplete-index"
import { AUTOCOMPLETE_INDEX_EXTENSION } from "#browser-runtime/resources"

/**
 * One place the index holds, read from the candidate table with its ancestors.
 */
export interface AutocompletePlace {
	sprID: number
	name: string
	nameKey: string
	placetype: string
	country: string
	latitude: number
	longitude: number
	/**
	 * The resolver's rank, ascending, as the candidate table stores it.
	 */
	negRank: number
	/**
	 * The display chain from the parent upward, as {@linkcode parentChain} reads it from the ancestors.
	 */
	parents: string[]
}

/**
 * The placetypes indexed regardless of population: the region rung and everything coarser,
 * as the Who's On First placetype order in `@mailwoman/core` ranks them.
 */
export const PLACETYPES_ALWAYS_INDEXED: ReadonlySet<string> = REGION_AND_COARSER_PLACETYPES

/**
 * One ancestor as `candidate_ancestor` lists it, from the parent upward.
 */
export interface PlaceAncestor {
	name: string
	placetype: string
}

/**
 * What a suggestion shows after the place: its locality when the place sits below one,
 * then its region or macroregion and its country, each name once.
 *
 * The ancestor table lists every placetype on the way up, boroughs and counties included.
 * London's row lists eight boroughs before England, so the chain keeps the region rung
 * and coarser, as the Who's On First placetype order ranks them, and drops the rest.
 */
export function parentChain(placetype: string, ancestors: readonly PlaceAncestor[]): string[] {
	const chain: string[] = []

	for (const ancestor of ancestors) {
		const shown =
			REGION_AND_COARSER_PLACETYPES.has(ancestor.placetype) ||
			(ancestor.placetype === "locality" && SUB_LOCALITY_PLACETYPES.has(placetype))

		if (shown && !chain.includes(ancestor.name)) {
			chain.push(ancestor.name)
		}
	}

	return chain
}

/**
 * The default population floor.
 *
 * On the 2026-08-25b gazetteer it admits 39,901 primary-name places across 23,208 distinct locality keys.
 */
export const DEFAULT_POPULATION_FLOOR = 20_000

/**
 * The directory under the staged root the files are written to, the first segment of their published key.
 */
export const AUTOCOMPLETE_DIRECTORY = "autocomplete"

/**
 * The trie entry for one place, or null when its folded name has no token.
 *
 * The entry id is the place's ordinal within its file, because a trie entry id is 32-bit
 * and an Overture-minted place id exceeds that, so the place id travels in the payload.
 * The rank is the resolver's rank negated, so a stronger candidate sorts first
 * in the trie as it does in the resolver.
 */
export function autocompleteEntry(place: AutocompletePlace, ordinal: number): AncestrieEntry | null {
	const tokens = autocompleteTokens(place.nameKey)

	if (!tokens.length) return null

	const payload: PlaceSuggestionPayload = {
		i: place.sprID,
		n: place.name,
		t: place.placetype,
		c: place.country,
		y: place.latitude,
		x: place.longitude,
		p: place.parents.join(", "),
	}

	return { tokens, id: ordinal, parentIDs: [], rank: -place.negRank, payload }
}

/**
 * Groups places by the partition file their first token selects, in partition order.
 */
export function groupPlacesByPartition(places: Iterable<AutocompletePlace>): Map<string, AutocompletePlace[]> {
	const groups = new Map<string, AutocompletePlace[]>()

	for (const place of places) {
		const [first] = autocompleteTokens(place.nameKey)

		if (!first) continue

		const partition = autocompletePartitionOf(first)
		const group = groups.get(partition)

		if (group) {
			group.push(place)
		} else {
			groups.set(partition, [place])
		}
	}

	return new Map([...groups.entries()].toSorted(([a], [b]) => a.localeCompare(b)))
}

/**
 * Reads the places the index holds from a candidate database: every primary-name row
 * with a coordinate whose population reaches `floor`, plus every country and region,
 * one row per place at its lowest rank, each with its ancestors.
 */
export async function readAutocompletePlaces(
	candidateDB: PathBuilderLike,
	floor = DEFAULT_POPULATION_FLOOR
): Promise<AutocompletePlace[]> {
	using db = await openBuiltClient(candidateDB)

	const always = [...PLACETYPES_ALWAYS_INDEXED].map((placetype) => `'${placetype}'`).join(", ")

	const rows = db
		.prepare(
			`SELECT c.spr_id, c.name, c.name_key, p.placetype, k.code AS country, c.latitude, c.longitude, c.neg_rank
			 FROM candidate c
			 JOIN placetype_codes p ON p.id = c.placetype_id
			 JOIN country_codes k ON k.id = c.country_id
			 WHERE c.is_primary = 1 AND c.latitude IS NOT NULL AND c.longitude IS NOT NULL
			   AND (c.population >= ? OR p.placetype IN (${always}))
			 ORDER BY c.neg_rank ASC`
		)
		.all(floor)

	const ancestors = db.prepare(
		`SELECT a.parent_name, p.placetype FROM candidate_ancestor a
		 JOIN placetype_codes p ON p.id = a.parent_placetype_id
		 WHERE a.spr_id = ? ORDER BY a.depth`
	)

	const seen = new Set<number>()
	const places: AutocompletePlace[] = []

	for (const row of rows) {
		const sprID = Number(row["spr_id"])

		if (seen.has(sprID)) continue

		seen.add(sprID)

		const placetype = String(row["placetype"])

		const lineage = ancestors
			.all(sprID)
			.map((parent) => ({ name: String(parent["parent_name"]), placetype: String(parent["placetype"]) }))

		places.push({
			sprID,
			name: String(row["name"]),
			nameKey: String(row["name_key"]),
			placetype,
			country: String(row["country"]),
			latitude: Number(row["latitude"]),
			longitude: Number(row["longitude"]),
			negRank: Number(row["neg_rank"]),
			parents: parentChain(placetype, lineage),
		})
	}

	return places
}

export interface WriteAutocompleteIndexOptions {
	/**
	 * The staged root the publisher uploads.
	 * The files land under `<outDir>/autocomplete/<version>/`.
	 */
	outDir: PathBuilderLike
	version: string
	floor: number
}

/**
 * Writes one sealed trie per partition and the manifest, and answers the manifest.
 */
export async function writeAutocompleteIndex(
	places: Iterable<AutocompletePlace>,
	options: WriteAutocompleteIndexOptions
): Promise<AutocompleteIndexManifest> {
	const generationDir = resolvePathBuilder(options.outDir, AUTOCOMPLETE_DIRECTORY, options.version)

	await makeDirectories(generationDir)

	const builtAt = isoSeconds()
	const files: AutocompleteIndexManifest["files"] = {}
	let entries = 0

	for (const [partition, group] of groupPlacesByPartition(places)) {
		const builder = new AncestrieBuilder()
		let count = 0

		for (const place of group) {
			const entry = autocompleteEntry(place, count)

			if (!entry) continue

			builder.add(entry)

			count++
		}

		if (!count) continue

		const bytes = builder.seal({ metadata: { builtAt, partition } })

		await writeLocalFile(bytes, generationDir(`${partition}${AUTOCOMPLETE_INDEX_EXTENSION}`))

		files[partition] = { entries: count, bytes: bytes.byteLength }
		entries += count
	}

	const manifest: AutocompleteIndexManifest = { version: options.version, floor: options.floor, entries, files }

	await writeLocalJSONFile(manifest, generationDir("index.json"))

	return manifest
}

export interface BuildAutocompleteIndexOptions extends WriteAutocompleteIndexOptions {
	candidateDB: PathBuilderLike
}

/**
 * Reads the places from the candidate database and writes the generation.
 */
export async function buildAutocompleteIndex(
	options: BuildAutocompleteIndexOptions
): Promise<AutocompleteIndexManifest> {
	const places = await readAutocompletePlaces(options.candidateDB, options.floor)

	return writeAutocompleteIndex(places, options)
}
