/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Contract tests for the reconcile concordance pre-fetch (#478): bounded queries, resolvable-tag
 *   filtering, score-order budget spending, ancestor chaining, and graceful backend failure.
 */

import { describe, expect, it } from "vitest"

import type { ResolvedPlace, ResolverBackend } from "../resolver/types.ts"
import { prefetchReconcileLookups } from "./reconcile-lookups.ts"
import type { ClassifierCandidate } from "./reconcile.ts"

const place = (id: number, name: string): ResolvedPlace =>
	({ id, name, placetype: "locality", lat: 1, lon: 2 }) as ResolvedPlace

function fakeBackend(calls: Array<{ text: string; placetype?: string | string[] }>): ResolverBackend {
	return {
		async findPlace(query) {
			calls.push({ text: query.text, placetype: query.placetype })

			if (query.text === "Springfield") return [place(1, "Springfield"), place(2, "Springfield")]

			if (query.text === "Illinois") return [place(10, "Illinois")]

			return []
		},
		ancestors(id) {
			if (id === 1) return [{ id: 10, placetype: "region", name: "Illinois" }]

			return []
		},
	}
}

const cand = (start: number, end: number, tag: ClassifierCandidate["tag"], score: number): ClassifierCandidate => ({
	span: { start, end },
	tag,
	score,
})

describe("prefetchReconcileLookups", () => {
	const raw = "Springfield Illinois"

	it("fetches per (span, tag) pair and serves sync lookups", async () => {
		const calls: Array<{ text: string }> = []
		const lookups = await prefetchReconcileLookups(fakeBackend(calls), raw, [
			cand(0, 11, "locality", 0.9),
			cand(12, 20, "region", 0.8),
		])
		expect(calls.map((c) => c.text)).toEqual(["Springfield", "Illinois"])
		expect(lookups.resolverCandidates.candidatesFor({ start: 0, end: 11 }, "locality")).toHaveLength(2)
		expect(lookups.resolverCandidates.candidatesFor({ start: 12, end: 20 }, "region")).toHaveLength(1)
		// Unfetched pair = empty, never undefined.
		expect(lookups.resolverCandidates.candidatesFor({ start: 0, end: 11 }, "region")).toEqual([])
	})

	it("chains ancestors at prefetch time for sync parentsOf", async () => {
		const lookups = await prefetchReconcileLookups(fakeBackend([]), raw, [cand(0, 11, "locality", 0.9)])
		const chain = lookups.parentChain.parentsOf(place(1, "Springfield"))
		expect(chain.map((p) => p.id)).toEqual([10])
		expect(lookups.parentChain.parentsOf(place(99, "Nowhere"))).toEqual([])
	})

	it("skips non-resolvable tags (street/house_number never hit the gazetteer)", async () => {
		const calls: Array<{ text: string }> = []
		await prefetchReconcileLookups(fakeBackend(calls), raw, [
			cand(0, 11, "street", 0.99),
			cand(0, 11, "house_number", 0.98),
			cand(12, 20, "region", 0.5),
		])
		expect(calls.map((c) => c.text)).toEqual(["Illinois"])
	})

	it("respects the lookup budget in candidate order", async () => {
		const calls: Array<{ text: string }> = []
		const many = Array.from({ length: 20 }, (_, i) => cand(i, i + 1, "locality" as const, 1 - i / 100))
		await prefetchReconcileLookups(fakeBackend(calls), "x".repeat(40), many, { maxLookups: 5 })
		expect(calls).toHaveLength(5)
	})

	it("degrades a throwing backend to empty evidence", async () => {
		const backend: ResolverBackend = {
			async findPlace() {
				throw new Error("backend down")
			},
		}
		const lookups = await prefetchReconcileLookups(backend, raw, [cand(0, 11, "locality", 0.9)])
		expect(lookups.resolverCandidates.candidatesFor({ start: 0, end: 11 }, "locality")).toEqual([])
	})
})
