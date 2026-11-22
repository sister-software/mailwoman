// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { AddressTree } from "@mailwoman/core/decoder"
import type {
	AddressPointLookup,
	RegionDatabases,
	ResolveOpts,
	Resolver,
	StreetCentroidLookup,
} from "@mailwoman/core/resolver"
import { describe, expect, test, vi } from "vitest"

import { geocodeAddress, type GeocodeClassifier } from "#geocode"

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
		artifactCoverage: null,
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
			placeCountry: "none",
			defaultCountry: { country: "FR", source: "caller" },
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
			placeCountry: "none",
			defaultCountry: { country: "DE", source: "caller" },
			nationalDatabases: frRegister,
			osmDatabases: (c) => (c === "de" ? { addressPoints: osmLookup } : {}),
		})

		expect(seen[0]?.addressPoints).toBe(osmLookup)

		expect(seen[0]?.addressPointBboxFallback).toBe(true)
	})

	const regionTree = (region: string): AddressTree => ({
		raw: "x",
		roots: [{ tag: "region", value: region, start: 0, end: region.length, confidence: 1, children: [] }],
	})

	test("a region's database outranks the national source of its own country, which is never consulted", async () => {
		const { resolver, seen } = captureResolver()
		const stateLookup = sentinel()
		const nationalDatabases = vi.fn((_c: string): RegionDatabases => ({ addressPoints: banLookup }))
		const databases = vi.fn((_subdivision: string | null): RegionDatabases => ({ addressPoints: stateLookup }))

		await geocodeAddress("350 5th Ave, New York, NY 10118", {
			classifier: fakeClassifier(regionTree("NY")),
			resolver,
			placeCountry: "none",
			defaultCountry: { country: "US", source: "caller" },
			databases,
			nationalDatabases,
		})

		expect(databases).toHaveBeenCalledWith("US-NY")
		expect(nationalDatabases).not.toHaveBeenCalled()
		expect(seen[0]?.addressPoints).toBe(stateLookup)
	})

	test("a region of another country ranks below the national source of the country the sources are picked for", async () => {
		const { resolver, seen } = captureResolver()
		const stateLookup = sentinel()

		// `MI` is a state of the United States for a tree with no resolved country, and the scope is France.
		await geocodeAddress("12 rue de la Paix, MI", {
			classifier: fakeClassifier(regionTree("MI")),
			resolver,
			placeCountry: "none",
			defaultCountry: { country: "FR", source: "caller" },
			databases: () => ({ addressPoints: stateLookup }),
			nationalDatabases: frRegister,
		})

		expect(seen[0]?.addressPoints).toBe(banLookup)
	})

	test("Wires the street-centroid provider + FR hint for a non-US parse", async () => {
		const { resolver, seen } = captureResolver()
		const streetLookup: StreetCentroidLookup = { find: vi.fn(() => null) }

		await geocodeAddress("Place Bellecour, Lyon", {
			classifier: fakeClassifier(emptyTree),
			resolver,
			placeCountry: "none",
			defaultCountry: { country: "FR", source: "caller" },
			nationalDatabases: (c) => (c === "fr" ? { streetCentroids: streetLookup } : {}),
		})

		expect(typeof seen[0]?.streetCentroids).toBe("function")
		expect(seen[0]?.streetCentroids?.("fr")).toBe(streetLookup)
		expect(seen[0]?.streetCentroids?.("de")).toBeNull()

		expect(seen[0]?.streetCountryHints).toContain("fr")
	})

	test("Absent nationalDatabases ⇒ no street-centroid tier (byte-stable,)", async () => {
		const { resolver, seen } = captureResolver()

		await geocodeAddress("Place Bellecour, Lyon", {
			classifier: fakeClassifier(emptyTree),
			resolver,
			placeCountry: "none",
			defaultCountry: { country: "FR", source: "caller" },
		})

		expect(seen[0]?.streetCentroids).toBeUndefined()
		expect(seen[0]?.streetCountryHints).toBeUndefined()
	})

	test("Absent nationalDatabases ⇒ byte-stable: the OSM tier serves FR unchanged (pre- behavior)", async () => {
		const { resolver, seen } = captureResolver()

		await geocodeAddress("12 rue de la Paix, Paris", {
			classifier: fakeClassifier(emptyTree),
			resolver,
			placeCountry: "none",
			defaultCountry: { country: "FR", source: "caller" },
			osmDatabases: (c) => (c === "fr" ? { addressPoints: osmLookup } : {}),
		})

		expect(seen[0]?.addressPoints).toBe(osmLookup)
		expect(seen[0]?.addressPointBboxFallback).toBe(true)
	})
})
