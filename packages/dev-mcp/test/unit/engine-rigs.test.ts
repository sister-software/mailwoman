/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the rig registry and its result normalization. The lifecycle itself (podman, a warm-up wait) is not
 *   simulated — a mocked container runtime would assert that the mock works. What IS pinned is the part a reader
 *   depends on and cannot check by eye: that each engine's identity lands in `sourceID`, because the whole reason to
 *   ask a rig anything is to learn WHICH dataset answered.
 */

import { ENGINE_RIGS, normalizeRigResults } from "@mailwoman/dev-mcp/engine-rigs"
import { describe, expect, it } from "vitest"

describe("ENGINE_RIGS", () => {
	it("pins every endpoint to loopback — the registry is the reason no host can be passed in", () => {
		for (const rig of Object.values(ENGINE_RIGS)) {
			expect(new URL(rig.endpoint).hostname, rig.engine).toBe("127.0.0.1")
		}
	})

	it("names the script that BUILDS each rig, so an absent container points somewhere", () => {
		for (const rig of Object.values(ENGINE_RIGS)) {
			expect(rig.rigScript, rig.engine).toMatch(/lifecycle\.sh$/)
		}
	})
})

describe("normalizeRigResults", () => {
	it("carries Pelias's gid — the field that says which dataset answered", () => {
		const [top] = normalizeRigResults("pelias", {
			features: [
				{
					properties: { name: "Rochester", layer: "locality", gid: "whosonfirst:locality:101750331" },
					geometry: { coordinates: [0.506, 51.3668] },
				},
			],
		})

		expect(top).toEqual({
			name: "Rochester",
			kind: "locality",
			sourceID: "whosonfirst:locality:101750331",
			lat: 51.3668,
			lon: 0.506,
		})
	})

	it("reads GeoJSON position as [lon, lat] — the transposition lands every answer in the wrong hemisphere", () => {
		const [top] = normalizeRigResults("photon", {
			features: [
				{
					properties: { name: "Telford", osm_type: "N", osm_id: 12_345, osm_value: "town" },
					// London: lon is the SMALL magnitude here, and swapping the pair puts this in the Indian Ocean.
					geometry: { coordinates: [-0.1278, 51.5074] },
				},
			],
		})

		expect(top?.lat).toBe(51.5074)
		expect(top?.lon).toBe(-0.1278)
		expect(top?.sourceID).toBe("osm:N:12345")
		expect(top?.kind).toBe("town")
	})

	it("returns an empty list for a payload with no features rather than inventing a null row", () => {
		expect(normalizeRigResults("pelias", { features: [] })).toEqual([])
		expect(normalizeRigResults("pelias", {})).toEqual([])
		expect(normalizeRigResults("photon", { error: "boom" })).toEqual([])
	})

	it("keeps a result whose identity fields are absent, with nulls — absence is reported, not dropped", () => {
		const [top] = normalizeRigResults("photon", {
			features: [{ properties: {}, geometry: { coordinates: [1, 2] } }],
		})

		expect(top).toEqual({ name: null, kind: null, sourceID: null, lat: 2, lon: 1 })
	})
})
