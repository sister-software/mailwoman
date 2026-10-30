/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Ancestrie, AncestrieBuilder } from "@mailwoman/ancestrie"
import { describe, expect, it } from "vitest"

import {
	type AutocompleteIndexManifest,
	autocompletePartitionOf,
	autocompleteTokens,
	PlaceAutocompleteIndex,
	type PlaceSuggestionPayload,
	suggestionDetail,
} from "#browser-runtime/autocomplete-index"

let ordinal = 0

/**
 * An entry with the place id in its payload and an ordinal as its trie id, as the build writes them.
 */
function entry(id: number, name: string, rank: number, payload: Omit<PlaceSuggestionPayload, "n" | "i">) {
	return {
		tokens: autocompleteTokens(name),
		id: ordinal++,
		parentIDs: [],
		rank,
		payload: { i: id, n: name, ...payload },
	}
}

/**
 * A trie for the `l` partition: two Londons, Londonderry and Long Beach.
 */
function londonTrie(): Ancestrie {
	const builder = new AncestrieBuilder()

	builder.add(
		entry(101_750_367, "London", 6.94, { t: "locality", c: "GB", y: 51.51, x: -0.1, p: "England, United Kingdom" })
	)

	builder.add(
		entry(8_887_748_781_345, "London", 5.63, { t: "locality", c: "CA", y: 42.98, x: -81.25, p: "Ontario, Canada" })
	)

	builder.add(
		entry(101_750_369, "Londonderry", 4.1, {
			t: "locality",
			c: "GB",
			y: 54.99,
			x: -7.31,
			p: "Northern Ireland, United Kingdom",
		})
	)

	builder.add(
		entry(85_923_517, "Long Beach", 5.65, {
			t: "locality",
			c: "US",
			y: 33.77,
			x: -118.19,
			p: "California, United States",
		})
	)

	return Ancestrie.from(builder.seal())
}

const manifest: AutocompleteIndexManifest = {
	version: "test",
	floor: 20_000,
	entries: 4,
	files: { l: { entries: 4, bytes: 0 } },
}

describe("autocomplete index", () => {
	it("tokens are the shared fold split on spaces, so a query and an entry agree on what a token is", () => {
		expect(autocompleteTokens("Little Britain")).toEqual(["little", "britain"])
		expect(autocompleteTokens("  Köln ")).toEqual(["koln"])
		expect(autocompleteTokens("")).toEqual([])
	})

	it("partitions file a Latin letter by itself, digits together and another script by its block", () => {
		expect(autocompletePartitionOf("london")).toBe("l")
		expect(autocompletePartitionOf("1600")).toBe("0")
		expect(autocompletePartitionOf("東京")).toBe("u67")
		expect(autocompletePartitionOf("москва")).toBe("u04")
		expect(autocompletePartitionOf("")).toBe("_")
	})

	it("query loads the first token's partition once and answers places strongest first, one per id", async () => {
		const loads: string[] = []

		const index = new PlaceAutocompleteIndex(
			async () => manifest,
			async (partition) => {
				loads.push(partition)

				return londonTrie()
			}
		)

		const first = await index.query("londo", 3)

		expect(first.map((hit) => [hit.name, hit.country])).toEqual([
			["London", "GB"],
			["London", "CA"],
			["Londonderry", "GB"],
		])

		expect(first[0]).toMatchObject({ id: 101_750_367, placetype: "locality", latitude: 51.51, longitude: -0.1 })
		expect(suggestionDetail(first[0]!)).toBe("locality · England, United Kingdom")
		expect(suggestionDetail({ ...first[0]!, parents: "" })).toBe("locality · GB")
		expect(suggestionDetail({ ...first[0]!, parents: "", placetype: "country" })).toBe("country")

		const second = await index.query("Long B", 3)

		expect(second.map((hit) => hit.name)).toEqual(["Long Beach"])
		expect(loads).toEqual(["l"])
	})

	it("query answers an empty list for a partition the generation holds no file for, without a load", async () => {
		const loads: string[] = []

		const index = new PlaceAutocompleteIndex(
			async () => manifest,
			async (partition) => {
				loads.push(partition)

				return londonTrie()
			}
		)

		await expect(index.query("Paris")).resolves.toEqual([])
		await expect(index.query("   ")).resolves.toEqual([])
		expect(loads).toEqual([])
	})
})
