/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { describe, expect, it, vi } from "vitest"

import { rerankByResolution } from "./rerank.ts"

/** A tree whose finest resolved node carries `tag` — `country` is what the guard vetoes. */
function resolvedTree(tag: string, raw = "x"): AddressTree {
	const node: AddressNode = {
		tag,
		value: raw,
		start: 0,
		end: raw.length,
		confidence: 1,
		children: [],
		placeID: "wof:1",
		lat: 1,
		lon: 2,
	} as unknown as AddressNode

	return { raw, roots: [node] }
}

const bare = (raw: string): AddressTree => ({ raw, roots: [] })

describe("rerankByResolution", () => {
	it("keeps the model's rank-1 when it resolves plausibly — no gratuitous reordering", async () => {
		const resolve = vi.fn(async () => resolvedTree("locality"))
		const out = await rerankByResolution(
			[
				{ score: -1, tree: bare("a"), payload: "a" },
				{ score: -2, tree: bare("b"), payload: "b" },
			],
			resolve
		)
		expect(out.best.payload).toBe("a")
		expect(out.changed).toBe(false)
		// Rank-1 was plausible, so rank-2 need not have been resolved at all... but the budget resolves
		// in order; what matters is the ANSWER is unchanged.
		expect(out.ranked[0]!.payload).toBe("a")
	})

	it("promotes rank-2 when rank-1 resolves to a country centroid — the arc's whole claim", async () => {
		const resolve = vi.fn(async (t: AddressTree) => (t.raw === "a" ? resolvedTree("country") : resolvedTree("street")))
		const out = await rerankByResolution(
			[
				{ score: -1, tree: bare("a"), payload: "rank1-garbage" },
				{ score: -2, tree: bare("b"), payload: "rank2-real" },
			],
			resolve
		)
		expect(out.best.payload).toBe("rank2-real")
		expect(out.changed).toBe(true)
		// The vetoed one is retained, with its reason — never silently dropped.
		const vetoed = out.ranked.find((r) => r.implausible)!
		expect(vetoed.payload).toBe("rank1-garbage")
		expect(vetoed.reason).toBe("country-centroid")
	})

	it("falls back to the model's rank-1 when EVERY candidate is implausible", async () => {
		// "All my evidence says these are all bad" is not grounds to invent a different answer.
		const resolve = vi.fn(async () => resolvedTree("country"))
		const out = await rerankByResolution(
			[
				{ score: -1, tree: bare("a"), payload: "rank1" },
				{ score: -2, tree: bare("b"), payload: "rank2" },
			],
			resolve
		)
		expect(out.best.payload).toBe("rank1")
		expect(out.changed).toBe(false)
	})

	it("does NOT veto a candidate when the resolver throws — an outage is not evidence", async () => {
		const resolve = vi.fn(async (t: AddressTree) => {
			if (t.raw === "a") throw new Error("resolver down")

			return resolvedTree("street")
		})
		const out = await rerankByResolution(
			[
				{ score: -1, tree: bare("a"), payload: "rank1" },
				{ score: -2, tree: bare("b"), payload: "rank2" },
			],
			resolve
		)
		expect(out.best.payload).toBe("rank1")
		expect(out.best.implausible).toBe(false)
		expect(out.changed).toBe(false)
	})

	it("resolves at most maxResolve candidates — the latency knob is real", async () => {
		const resolve = vi.fn(async () => resolvedTree("locality"))
		const candidates = Array.from({ length: 10 }, (_, i) => ({ score: -i, tree: bare(`c${i}`), payload: i }))
		await rerankByResolution(candidates, resolve, { maxResolve: 3 })
		expect(resolve).toHaveBeenCalledTimes(3)
	})

	it("carries unresolved (beyond-budget) candidates through without vetoing them", async () => {
		const resolve = vi.fn(async () => resolvedTree("country")) // everything resolved is vetoed
		const candidates = Array.from({ length: 4 }, (_, i) => ({ score: -i, tree: bare(`c${i}`), payload: i }))
		const out = await rerankByResolution(candidates, resolve, { maxResolve: 2 })
		// c2/c3 were never resolved → not implausible → they outrank the two vetoed ones.
		expect(out.best.payload).toBe(2)
		expect(out.ranked.filter((r) => r.implausible)).toHaveLength(2)
	})

	it("throws on an empty candidate list rather than inventing a result", async () => {
		await expect(rerankByResolution([], async (t) => t)).rejects.toThrow(/must not be empty/)
	})
})
