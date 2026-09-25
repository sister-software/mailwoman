import type { AddressTree } from "@mailwoman/core/decoder"
import type { AddressPointLookup, ResolveOpts, Resolver, StreetCentroidLookup } from "@mailwoman/core/resolver"
import { geocodeAddress, type GeocodeClassifier, type RegionDatabases } from "mailwoman/geocode"
import { describe, expect, test, vi } from "vitest"

function fakeClassifier(tree: AddressTree): GeocodeClassifier {
	return { parse: vi.fn(async () => tree) }
}

function captureResolver(): { resolver: Resolver; seen: ResolveOpts[] } {
	const seen: ResolveOpts[] = []

	const resolver: Resolver = {
		resolveTree: vi.fn(async (tree, opts) => {
			seen.push(opts ?? {})

			return tree
		}),
	}

	return { resolver, seen }
}

const emptyTree: AddressTree = { raw: "x", roots: [] }

const sentinel = (): AddressPointLookup => ({ find: vi.fn(() => null) })
const banLookup = sentinel()
const osmLookup = sentinel()
const frRegister = (c: string): RegionDatabases => (c === "fr" ? { addressPoints: banLookup } : {})

describe("GeocodeAddress — national (BAN) rooftop tier wiring", () => {
	test("BAN wins over OSM for a non-US parse (consulted AHEAD of the OSM tier)", async () => {
		const { resolver, seen } = captureResolver()

		await geocodeAddress("12 rue de la Paix, Paris", {
			classifier: fakeClassifier(emptyTree),
			resolver,
			placeCountry: false,
			defaultCountry: "FR",
			nationalDatabases: frRegister,
			osmDatabases: (c) => (c === "fr" ? { addressPoints: osmLookup } : {}),
		})

		expect(seen[0]?.addressPoints).toBe(banLookup)

		expect(seen[0]?.addressPointBboxFallback).toBe(true)
	})

	test("falls through to the OSM tier when no national register covers the country", async () => {
		const { resolver, seen } = captureResolver()

		await geocodeAddress("Hauptstraße 5, Berlin", {
			classifier: fakeClassifier(emptyTree),
			resolver,
			placeCountry: false,
			defaultCountry: "DE",
			nationalDatabases: frRegister,
			osmDatabases: (c) => (c === "de" ? { addressPoints: osmLookup } : {}),
		})

		expect(seen[0]?.addressPoints).toBe(osmLookup)

		expect(seen[0]?.addressPointBboxFallback).toBe(true)
	})

	test("a US parse never consults BAN (the US situs path owns address points)", async () => {
		const { resolver, seen } = captureResolver()
		const nationalDatabases = vi.fn((_c: string): RegionDatabases => ({ addressPoints: banLookup }))

		await geocodeAddress("350 5th Ave, New York, NY 10118", {
			classifier: fakeClassifier(emptyTree),
			resolver,
			placeCountry: false,
			defaultCountry: "US",
			nationalDatabases,
		})

		expect(nationalDatabases).not.toHaveBeenCalled()
		expect(seen[0]?.addressPoints).toBeUndefined()
	})

	test("Wires the street-centroid provider + FR hint for a non-US parse", async () => {
		const { resolver, seen } = captureResolver()
		const streetLookup: StreetCentroidLookup = { find: vi.fn(() => null) }

		await geocodeAddress("Place Bellecour, Lyon", {
			classifier: fakeClassifier(emptyTree),
			resolver,
			placeCountry: false,
			defaultCountry: "FR",
			nationalDatabases: (c) => (c === "fr" ? { streetCentroids: streetLookup } : {}),
		})

		expect(typeof seen[0]?.streetCentroids).toBe("function")
		expect(seen[0]?.streetCentroids?.("fr")).toBe(streetLookup)
		expect(seen[0]?.streetCentroids?.("de")).toBeUndefined()

		expect(seen[0]?.streetCountryHints).toContain("fr")
	})

	test("Absent nationalDatabases ⇒ no street-centroid tier (byte-stable,)", async () => {
		const { resolver, seen } = captureResolver()

		await geocodeAddress("Place Bellecour, Lyon", {
			classifier: fakeClassifier(emptyTree),
			resolver,
			placeCountry: false,
			defaultCountry: "FR",
		})

		expect(seen[0]?.streetCentroids).toBeUndefined()
		expect(seen[0]?.streetCountryHints).toBeUndefined()
	})

	test("Absent nationalDatabases ⇒ byte-stable: the OSM tier serves FR unchanged (pre- behavior)", async () => {
		const { resolver, seen } = captureResolver()

		await geocodeAddress("12 rue de la Paix, Paris", {
			classifier: fakeClassifier(emptyTree),
			resolver,
			placeCountry: false,
			defaultCountry: "FR",
			osmDatabases: (c) => (c === "fr" ? { addressPoints: osmLookup } : {}),
		})

		expect(seen[0]?.addressPoints).toBe(osmLookup)
		expect(seen[0]?.addressPointBboxFallback).toBe(true)
	})
})
