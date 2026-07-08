/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the national open-register rooftop tier wiring in `geocodeAddress` (#1012, BAN-FR).
 *   Fakes the classifier + resolver so the test captures the `ResolveOpts` the cascade hands the
 *   resolver — no WOF / weights / shards / 7 GB BAN db needed. Pins the tier contract:
 *
 *   - a non-US parse consults `nationalShards` (BAN) AHEAD of `osmShards` — BAN wins where it covers;
 *   - BAN carries its own postcode + commune, so it sets NO bbox fall-through (unlike the OSM tier);
 *   - when no national register covers the country, the cascade falls through to the OSM tier;
 *   - a US parse never consults BAN (the US situs path owns address points);
 *   - absent `nationalShards`, the cascade is byte-stable — the tier is purely additive.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import type { AddressPointLookup, ResolveOpts, Resolver } from "@mailwoman/resolver"
import { describe, expect, test, vi } from "vitest"

import { geocodeAddress, type GeocodeClassifier, type StateShards } from "../geocode-core.js"

/** A classifier that returns a fixed tree (no region → admin-only path, no US situs shards needed). */
function fakeClassifier(tree: AddressTree): GeocodeClassifier {
	return { parse: vi.fn(async () => tree) }
}

/** A resolver that records the ResolveOpts it was handed and echoes the tree back. */
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

/** A sentinel address-point lookup — the cascade only assigns it to `opts.addressPoints`, never calls `find`. */
const sentinel = (): AddressPointLookup => ({ find: vi.fn(() => null) })
const banLookup = sentinel()
const osmLookup = sentinel()
const frRegister = (c: string): StateShards => (c === "fr" ? { addressPoints: banLookup } : {})

describe("geocodeAddress — national (BAN) rooftop tier wiring (#1012)", () => {
	test("BAN wins over OSM for a non-US parse (consulted AHEAD of the OSM tier)", async () => {
		const { resolver, seen } = captureResolver()
		await geocodeAddress("12 rue de la Paix, Paris", {
			classifier: fakeClassifier(emptyTree),
			resolver,
			placeCountry: false,
			defaultCountry: "FR",
			nationalShards: frRegister,
			osmShards: (c) => (c === "fr" ? { addressPoints: osmLookup } : {}),
		})
		expect(seen[0]?.addressPoints).toBe(banLookup)
		// BAN rows carry their own postcode + commune → the scoped probes suffice; no bbox fall-through.
		expect(seen[0]?.addressPointBboxFallback).toBeUndefined()
	})

	test("falls through to the OSM tier when no national register covers the country", async () => {
		const { resolver, seen } = captureResolver()
		await geocodeAddress("Hauptstraße 5, Berlin", {
			classifier: fakeClassifier(emptyTree),
			resolver,
			placeCountry: false,
			defaultCountry: "DE",
			nationalShards: frRegister, // FR-only register → no DE coverage
			osmShards: (c) => (c === "de" ? { addressPoints: osmLookup } : {}),
		})
		expect(seen[0]?.addressPoints).toBe(osmLookup)
		// The OSM tier's points carry no scope tag, so its bbox fall-through IS enabled.
		expect(seen[0]?.addressPointBboxFallback).toBe(true)
	})

	test("a US parse never consults BAN (the US situs path owns address points)", async () => {
		const { resolver, seen } = captureResolver()
		const nationalShards = vi.fn((_c: string): StateShards => ({ addressPoints: banLookup }))
		await geocodeAddress("350 5th Ave, New York, NY 10118", {
			classifier: fakeClassifier(emptyTree),
			resolver,
			placeCountry: false,
			defaultCountry: "US",
			nationalShards,
		})
		expect(nationalShards).not.toHaveBeenCalled()
		expect(seen[0]?.addressPoints).toBeUndefined()
	})

	test("absent nationalShards ⇒ byte-stable: the OSM tier serves FR unchanged (pre-#1012 behavior)", async () => {
		const { resolver, seen } = captureResolver()
		await geocodeAddress("12 rue de la Paix, Paris", {
			classifier: fakeClassifier(emptyTree),
			resolver,
			placeCountry: false,
			defaultCountry: "FR",
			osmShards: (c) => (c === "fr" ? { addressPoints: osmLookup } : {}),
		})
		expect(seen[0]?.addressPoints).toBe(osmLookup)
		expect(seen[0]?.addressPointBboxFallback).toBe(true)
	})
})
