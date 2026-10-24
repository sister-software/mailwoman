/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Ancestrie } from "@mailwoman/ancestrie"
import { readLocalBuffer, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { afterAll, describe, expect, it } from "vitest"

import { type AutocompleteIndexManifest, PlaceAutocompleteIndex } from "#browser-runtime/autocomplete-index"
import {
	autocompleteEntry,
	type AutocompletePlace,
	groupPlacesByPartition,
	parentChain,
	writeAutocompleteIndex,
} from "#tools/release-tools/publish/autocomplete-index"

const root = await temporaryDirectory("mw-autocomplete-index-")

afterAll(() => root[Symbol.asyncDispose]())

function place(
	overrides: Partial<AutocompletePlace> & Pick<AutocompletePlace, "sprID" | "name" | "nameKey">
): AutocompletePlace {
	return {
		placetype: "locality",
		country: "GB",
		latitude: 51.5,
		longitude: -0.1,
		negRank: -5,
		parents: ["England", "United Kingdom"],
		...overrides,
	}
}

const PLACES: AutocompletePlace[] = [
	place({ sprID: 101_750_367, name: "London", nameKey: "london", negRank: -6.94 }),
	place({
		sprID: 85_633_159,
		name: "United Kingdom",
		nameKey: "united kingdom",
		placetype: "country",
		negRank: -9,
		parents: [],
	}),
	place({
		sprID: 102_063_715,
		name: "Köln",
		nameKey: "koln",
		country: "DE",
		negRank: -6.4,
		parents: ["Nordrhein-Westfalen", "Deutschland"],
	}),
	place({ sprID: 1, name: "Tokyo", nameKey: "東京", country: "JP", negRank: -7, parents: ["Japan"] }),
]

describe("autocomplete index build", () => {
	it("parentChain keeps the region and country, adds the locality below one, and drops boroughs and counties", () => {
		const london = [
			{ name: "Kingston upon Thames", placetype: "borough" },
			{ name: "Croydon", placetype: "borough" },
			{ name: "Greater London", placetype: "region" },
			{ name: "England", placetype: "macroregion" },
			{ name: "United Kingdom", placetype: "country" },
		]

		expect(parentChain("locality", london)).toEqual(["Greater London", "England", "United Kingdom"])

		const camden = [
			{ name: "London", placetype: "locality" },
			{ name: "Camden", placetype: "borough" },
			...london.slice(2),
		]

		expect(parentChain("neighbourhood", camden)).toEqual(["London", "Greater London", "England", "United Kingdom"])
		expect(parentChain("locality", camden)).toEqual(["Greater London", "England", "United Kingdom"])

		const ontario = [
			{ name: "London", placetype: "county" },
			{ name: "Ontario", placetype: "region" },
			{ name: "Canada", placetype: "country" },
		]

		expect(parentChain("locality", ontario)).toEqual(["Ontario", "Canada"])
		expect(parentChain("country", [])).toEqual([])
	})

	it("autocompleteEntry keys the place by its folded tokens, negates the rank and packs the payload", () => {
		const entry = autocompleteEntry(PLACES[0]!, 7)

		expect(entry).toEqual({
			tokens: ["london"],
			id: 7,
			parentIDs: [],
			rank: 6.94,
			payload: { i: 101_750_367, n: "London", t: "locality", c: "GB", y: 51.5, x: -0.1, p: "England, United Kingdom" },
		})

		expect(autocompleteEntry(place({ sprID: 2, name: "", nameKey: "" }), 0)).toBeNull()
	})

	it("groupPlacesByPartition groups by the first token's partition in partition order", () => {
		const groups = groupPlacesByPartition(PLACES)

		expect([...groups.keys()]).toEqual(["k", "l", "u", "u67"])
		expect(groups.get("u")!.map((entry) => entry.name)).toEqual(["United Kingdom"])
	})

	it("writeAutocompleteIndex writes one trie per partition and a manifest the client reads back", async () => {
		const manifest = await writeAutocompleteIndex(PLACES, { outDir: root.path, version: "test-gen", floor: 20_000 })

		expect(manifest.version).toBe("test-gen")
		expect(manifest.entries).toBe(4)
		expect(Object.keys(manifest.files)).toEqual(["k", "l", "u", "u67"])
		expect(manifest.files["l"]!.entries).toBe(1)
		expect(manifest.files["l"]!.bytes).toBeGreaterThan(0)

		const onDisk = await readLocalJSONFile<AutocompleteIndexManifest>(
			root.path("autocomplete", "test-gen", "index.json")
		)

		expect(onDisk).toEqual(manifest)

		const index = new PlaceAutocompleteIndex(
			async () => onDisk,
			async (partition) =>
				Ancestrie.from(await readLocalBuffer(root.path("autocomplete", "test-gen", `${partition}.anct`)))
		)

		expect((await index.query("Lon")).map((hit) => hit.name)).toEqual(["London"])

		expect((await index.query("Köln"))[0]).toMatchObject({
			name: "Köln",
			country: "DE",
			parents: "Nordrhein-Westfalen, Deutschland",
		})

		expect((await index.query("東"))[0]).toMatchObject({ name: "Tokyo", country: "JP" })
		expect(await index.query("Paris")).toEqual([])
	})
})
