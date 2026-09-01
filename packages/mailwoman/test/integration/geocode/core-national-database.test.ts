/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the national open-register rooftop tier wiring in `geocodeAddress` (#1012, BAN-FR).
 *   Fakes the classifier + resolver so the test captures the `ResolveOpts` the cascade hands the
 *   resolver — no WOF / weights / databases / 7 GB BAN db needed. Pins the tier contract:
 *
 *   - a non-US parse consults `nationalDatabases` (BAN) AHEAD of `osmDatabases` — BAN wins where it covers;
 *   - BAN carries its own postcode + commune, so it sets NO bbox fall-through (unlike the OSM tier);
 *   - when no national register covers the country, the cascade falls through to the OSM tier;
 *   - a US parse never consults BAN (the US situs path owns address points);
 *   - absent `nationalDatabases`, the cascade is byte-stable — the tier is purely additive.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import type { AddressPointLookup, ResolveOpts, Resolver, StreetCentroidLookup } from "@mailwoman/resolver"
import { geocodeAddress, type GeocodeClassifier, type RegionDatabases } from "mailwoman/geocode"
import { describe, expect, test, vi } from "vitest"

/**
 * A classifier that returns a fixed tree (no region → admin-only path, no US situs databases needed).
 */
function fakeClassifier(tree: AddressTree): GeocodeClassifier {
	return { parse: vi.fn(async () => tree) }
}

/**
 * A resolver that records the ResolveOpts it was handed and echoes the tree back.
 */
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

/**
 * A sentinel address-point lookup — the cascade only assigns it to `opts.addressPoints`, never calls `find`.
 */
const sentinel = (): AddressPointLookup => ({ find: vi.fn(() => null) })
const banLookup = sentinel()
const osmLookup = sentinel()
const frRegister = (c: string): RegionDatabases => (c === "fr" ? { addressPoints: banLookup } : {})

describe("geocodeAddress — national (BAN) rooftop tier wiring (#1012)", () => {
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
		// Bbox fall-through is ON for the national tier (2026-07-10): the register's ROWS carry
		// postcode + commune, but the QUERY often doesn't — and BAN communes are INSEE-arrondissement-
		// granular, so a city-level locality probe ("paris") misses "paris 13e arrondissement". The
		// resolved locality's box scopes the (street, number) probe instead (fr-chevaleret-bare).
		expect(seen[0]?.addressPointBboxFallback).toBe(true)
	})

	test("falls through to the OSM tier when no national register covers the country", async () => {
		const { resolver, seen } = captureResolver()

		await geocodeAddress("Hauptstraße 5, Berlin", {
			classifier: fakeClassifier(emptyTree),
			resolver,
			placeCountry: false,
			defaultCountry: "DE",
			nationalDatabases: frRegister, // FR-only register → no DE coverage
			osmDatabases: (c) => (c === "de" ? { addressPoints: osmLookup } : {}),
		})

		expect(seen[0]?.addressPoints).toBe(osmLookup)
		// The OSM tier's points carry no scope tag, so its bbox fall-through IS enabled.
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

	test("wires the street-centroid provider + FR hint for a non-US parse (#1042)", async () => {
		const { resolver, seen } = captureResolver()
		const streetLookup: StreetCentroidLookup = { find: vi.fn(() => null) }

		await geocodeAddress("Place Bellecour, Lyon", {
			classifier: fakeClassifier(emptyTree),
			resolver,
			placeCountry: false,
			defaultCountry: "FR",
			nationalDatabases: (c) => (c === "fr" ? { streetCentroids: streetLookup } : {}),
		})

		// A country-keyed PROVIDER (not a bare lookup): resolves the FR database, undefined for a country BAN lacks.
		expect(typeof seen[0]?.streetCentroids).toBe("function")
		expect(seen[0]?.streetCentroids?.("fr")).toBe(streetLookup)
		expect(seen[0]?.streetCentroids?.("de")).toBeUndefined()
		// The pre-resolution hint carries the country the tier's union starts from.
		expect(seen[0]?.streetCountryHints).toContain("fr")
	})

	test("absent nationalDatabases ⇒ no street-centroid tier (byte-stable, #1042)", async () => {
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

	test("absent nationalDatabases ⇒ byte-stable: the OSM tier serves FR unchanged (pre-#1012 behavior)", async () => {
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
