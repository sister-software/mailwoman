/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import type { POIIntent } from "@mailwoman/core/pipeline"
import type { POISearchHit, POISearchQuery } from "@mailwoman/resolver-wof-sqlite/poi-lookup"
import { describe, expect, it } from "vitest"

import { createPOIExecutor, type POIExecutorLookup } from "./poi-executor.ts"

const SPRINGFIELD_TREE: AddressTree = {
	raw: "Springfield IL",
	roots: [
		{
			tag: "locality",
			value: "Springfield",
			start: 0,
			end: 11,
			confidence: 0.9,
			children: [],
			lat: 39.78,
			lon: -89.65,
		},
	],
}

const HOSPITAL_HIT: POISearchHit = {
	name: "Springfield General",
	categoryID: "hospital",
	brandWikidata: null,
	latitude: 39.781,
	longitude: -89.651,
	country: "US",
	confidence: 0.8,
	distanceM: 120,
}

function stubLookup(fn: (query: POISearchQuery) => POISearchHit[]): POIExecutorLookup {
	return { search: fn }
}

const NEVER_BUILD_LOCAL = () => false

describe("createPOIExecutor", () => {
	it("category happy path: resolves the center from the anchor tree and returns mapped results", () => {
		const seenQueries: POISearchQuery[] = []
		const executor = createPOIExecutor({
			lookup: stubLookup((query) => {
				seenQueries.push(query)

				return [HOSPITAL_HIT]
			}),
			requiresBuildLocal: NEVER_BUILD_LOCAL,
		})

		const intent: POIIntent = {
			subject: { kind: "category", categoryID: "hospital", matched: "hospital" },
			anchor: { text: "Springfield IL", tree: SPRINGFIELD_TREE },
		}
		const outcome = executor(intent)

		expect(outcome.type).toBe("intent")

		if (outcome.type !== "intent") throw new Error("unreachable")
		expect(outcome.results).toEqual([
			{
				name: "Springfield General",
				categoryID: "hospital",
				brandWikidata: null,
				latitude: 39.781,
				longitude: -89.651,
				country: "US",
				confidence: 0.8,
				distanceM: 120,
			},
		])
		expect(seenQueries).toEqual([
			{ categoryID: "hospital", center: { latitude: 39.78, longitude: -89.65 }, limit: undefined },
		])
	})

	it("anchor_required: category subject, lookup present, no resolvable center", () => {
		const executor = createPOIExecutor({
			lookup: stubLookup(() => [HOSPITAL_HIT]),
			requiresBuildLocal: NEVER_BUILD_LOCAL,
		})

		const outcome = executor({ subject: { kind: "category", categoryID: "hospital", matched: "hospital" } })

		expect(outcome).toEqual({ type: "abstain", reason: "anchor_required" })
	})

	it("anchor_required: a bare biasPoint anchor is honored (no abstain)", () => {
		const executor = createPOIExecutor({
			lookup: stubLookup(() => [HOSPITAL_HIT]),
			requiresBuildLocal: NEVER_BUILD_LOCAL,
		})

		const outcome = executor({
			subject: { kind: "category", categoryID: "hospital", matched: "hospital" },
			anchor: { biasPoint: { latitude: 1, longitude: 2 } },
		})

		expect(outcome.type).toBe("intent")
	})

	it("requires_build_local_layer: fire_hydrant, lookup present, empty result set", () => {
		const executor = createPOIExecutor({
			lookup: stubLookup(() => []),
			requiresBuildLocal: (categoryID) => categoryID === "fire_hydrant",
		})

		const intent: POIIntent = {
			subject: { kind: "category", categoryID: "fire_hydrant", matched: "fire hydrant" },
			anchor: { text: "Springfield IL", tree: SPRINGFIELD_TREE },
		}
		const outcome = executor(intent)

		expect(outcome).toEqual({ type: "abstain", reason: "requires_build_local_layer" })
	})

	it("requires_build_local_layer: fires with NO lookup at all, even with no anchor", () => {
		const executor = createPOIExecutor({
			lookup: undefined,
			requiresBuildLocal: (categoryID) => categoryID === "fire_hydrant",
		})

		const outcome = executor({ subject: { kind: "category", categoryID: "fire_hydrant", matched: "fire hydrant" } })

		expect(outcome).toEqual({ type: "abstain", reason: "requires_build_local_layer" })
	})

	it("intent-only passthrough: no lookup configured, non-build-local category", () => {
		const executor = createPOIExecutor({ lookup: undefined, requiresBuildLocal: NEVER_BUILD_LOCAL })

		const intent: POIIntent = { subject: { kind: "category", categoryID: "hospital", matched: "hospital" } }
		const outcome = executor(intent)

		expect(outcome).toEqual({ type: "intent", intent })
	})

	it("name search without center: OK, no abstain, search runs un-anchored", () => {
		const seenQueries: POISearchQuery[] = []
		const nameHit: POISearchHit = {
			name: "Joe's Diner",
			categoryID: null,
			brandWikidata: null,
			latitude: 10,
			longitude: 20,
			country: "US",
			confidence: 0.6,
		}
		const executor = createPOIExecutor({
			lookup: stubLookup((query) => {
				seenQueries.push(query)

				return [nameHit]
			}),
			requiresBuildLocal: NEVER_BUILD_LOCAL,
		})

		const outcome = executor({ subject: { kind: "name", text: "Joe's Diner" } })

		expect(outcome.type).toBe("intent")

		if (outcome.type !== "intent") throw new Error("unreachable")
		expect(outcome.results).toEqual([
			{
				name: "Joe's Diner",
				categoryID: null,
				brandWikidata: null,
				latitude: 10,
				longitude: 20,
				country: "US",
				confidence: 0.6,
			},
		])
		expect(seenQueries).toEqual([{ name: "Joe's Diner", center: undefined, limit: undefined }])
	})
})
