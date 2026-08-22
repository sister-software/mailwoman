/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the stranded-affix repair. The load-bearing cases are the REFUSALS: this pass rewrites a place name, so
 *   the interesting question is never "does it join `Brixton` to `Hill`" but "what does it leave alone".
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { repairStrandedAffix } from "mailwoman/stranded-affix-repair"
import { describe, expect, it } from "vitest"

function node(tag: string, value: string, start: number, children: AddressNode[] = []): AddressNode {
	return { tag, value, start, end: start + value.length, confidence: 0.9, children } as AddressNode
}

function tagged(tree: AddressTree): string[] {
	const out: string[] = []

	const walk = (nodes: readonly AddressNode[]): void => {
		for (const n of nodes) {
			out.push(`${n.tag}:${n.value}`)

			if (n.children?.length) {
				walk(n.children)
			}
		}
	}

	walk(tree.roots)

	return out.toSorted()
}

describe("repairStrandedAffix", () => {
	it("reunites a trailing suffix with the locality it abuts — the #1747 case", () => {
		const raw = "Brixton Hill, United Kingdom"

		const tree: AddressTree = {
			raw,
			roots: [node("locality", "Brixton", 0), node("street_suffix", "Hill", 8), node("country", "United Kingdom", 14)],
		} as AddressTree

		expect(repairStrandedAffix(tree)).toBe(true)
		expect(tagged(tree)).toEqual(["country:United Kingdom", "locality:Brixton Hill"])
	})

	it("reunites a LEADING affix too — the same defect from the other side", () => {
		const raw = "Mount Pleasant, Spain"

		const tree: AddressTree = {
			raw,
			roots: [node("street_prefix", "Mount", 0), node("locality", "Pleasant", 6), node("country", "Spain", 16)],
		} as AddressTree

		expect(repairStrandedAffix(tree)).toBe(true)
		expect(tagged(tree)).toEqual(["country:Spain", "locality:Mount Pleasant"])
	})

	it("leaves a suffix alone when a street exists — it has a legitimate owner", () => {
		const raw = "12 Main Street, London"

		const tree: AddressTree = {
			raw,
			roots: [
				node("house_number", "12", 0),
				node("street", "Main", 3),
				node("street_suffix", "Street", 8),
				node("locality", "London", 16),
			],
		} as AddressTree

		expect(repairStrandedAffix(tree)).toBe(false)
		expect(tagged(tree)).toContain("street_suffix:Street")
	})

	it("leaves a NON-ADJACENT stranded suffix alone — a one-word street is not a naming error", () => {
		// "12 Hill, London": `Hill` is genuinely the street, and nowhere near the locality.
		const raw = "12 Hill, London"

		const tree: AddressTree = {
			raw,
			roots: [node("house_number", "12", 0), node("street_suffix", "Hill", 3), node("locality", "London", 9)],
		} as AddressTree

		expect(repairStrandedAffix(tree)).toBe(false)
		expect(tagged(tree)).toContain("street_suffix:Hill")
	})

	it("never absorbs a house_number, which would invent a name nobody wrote", () => {
		const raw = "12 London"

		const tree: AddressTree = {
			raw,
			roots: [node("house_number", "12", 0), node("locality", "London", 3)],
		} as AddressTree

		expect(repairStrandedAffix(tree)).toBe(false)
		expect(tagged(tree)).toEqual(["house_number:12", "locality:London"])
	})

	it("absorbs into a venue as readily as a locality", () => {
		const raw = "Bishops Stortford"

		const tree: AddressTree = {
			raw,
			roots: [node("venue", "Bishops", 0), node("street_suffix", "Stortford", 8)],
		} as AddressTree

		expect(repairStrandedAffix(tree)).toBe(true)
		expect(tagged(tree)).toEqual(["venue:Bishops Stortford"])
	})

	it("is a no-op on a tree with no affix at all", () => {
		const tree: AddressTree = {
			raw: "London, United Kingdom",
			roots: [node("locality", "London", 0), node("country", "United Kingdom", 8)],
		} as AddressTree

		expect(repairStrandedAffix(tree)).toBe(false)
	})

	it("detaches an affix nested UNDER the node it merges into", () => {
		const raw = "Brixton Hill"
		const suffix = node("street_suffix", "Hill", 8)
		const tree: AddressTree = { raw, roots: [node("locality", "Brixton", 0, [suffix])] } as AddressTree

		expect(repairStrandedAffix(tree)).toBe(true)
		expect(tagged(tree)).toEqual(["locality:Brixton Hill"])
	})
})
