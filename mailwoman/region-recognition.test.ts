/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressNode, AddressTree, ComponentTag } from "@mailwoman/core/decoder"
import { describe, expect, it } from "vitest"

import { recognizeUSRegions, usStateSlug } from "./region-recognition.js"

const loc = (value: string, start = 0, end = value.length, children: AddressNode[] = []): AddressNode => ({
	tag: "locality" as ComponentTag,
	value,
	start,
	end,
	confidence: 0.9,
	children,
})
const tree = (roots: AddressNode[]): AddressTree => ({
	roots,
	raw: roots.map((r) => r.value).join(", "),
	system: "western",
})
const tagsOf = (n: AddressNode): string =>
	`${n.tag}:${n.value}${n.children.length ? `[${n.children.map(tagsOf).join(",")}]` : ""}`

describe("usStateSlug", () => {
	it("recognizes full names and 2-letter abbreviations, case/space-insensitive", () => {
		expect(usStateSlug("Texas")).toBe("tx")
		expect(usStateSlug("  texas ")).toBe("tx")
		expect(usStateSlug("TX")).toBe("tx")
		expect(usStateSlug("New York")).toBe("ny")
		expect(usStateSlug("District of Columbia")).toBe("dc")
	})
	it("rejects non-states and multi-token values", () => {
		expect(usStateSlug("Dublin")).toBeNull()
		expect(usStateSlug("Dublin, TX")).toBeNull() // whole value, not a bare state
		expect(usStateSlug("XZ")).toBeNull()
	})
})

describe("recognizeUSRegions (#642)", () => {
	it('nests a sibling city under a state-name locality ("Dublin, Texas" → 2 localities)', () => {
		const t = recognizeUSRegions(tree([loc("Dublin"), loc("Texas")]))
		expect(t.roots.map(tagsOf)).toEqual(["region:Texas[locality:Dublin]"])
	})

	it('splits a merged "City, ST" locality into region → locality', () => {
		const t = recognizeUSRegions(tree([loc("Dublin, TX")]))
		expect(t.roots.map(tagsOf)).toEqual(["region:TX[locality:Dublin]"])
	})

	it('splits a merged "City, State" (full name) locality', () => {
		const t = recognizeUSRegions(tree([loc("Athens, Texas")]))
		expect(t.roots.map(tagsOf)).toEqual(["region:Texas[locality:Athens]"])
	})

	it("leaves an already-correct parse (explicit region) untouched", () => {
		const region: AddressNode = { ...loc("TX"), tag: "region" as ComponentTag, children: [loc("Dublin")] }
		const t = recognizeUSRegions(tree([region]))
		expect(t.roots.map(tagsOf)).toEqual(["region:TX[locality:Dublin]"])
	})

	it("leaves a LONE state-name locality untouched (no sibling city to nest — ambiguous city/state)", () => {
		const t = recognizeUSRegions(tree([loc("Washington")]))
		expect(t.roots.map(tagsOf)).toEqual(["locality:Washington"]) // not converted
	})

	it("does not fire when BOTH tokens are state-names (ambiguous; conservative no-op)", () => {
		const t = recognizeUSRegions(tree([loc("Washington"), loc("Pennsylvania")]))
		// Neither is unambiguously the city, so leave both as the parser had them.
		expect(t.roots.map(tagsOf)).toEqual(["locality:Washington", "locality:Pennsylvania"])
	})

	it("preserves a street + recognizes the region in a fuller address", () => {
		const street: AddressNode = { ...loc("100 Main St"), tag: "street" as ComponentTag }
		const t = recognizeUSRegions(tree([street, loc("Dublin"), loc("Texas")]))
		const tags = t.roots.map(tagsOf).sort()
		expect(tags).toContain("region:Texas[locality:Dublin]")
		expect(tags).toContain("street:100 Main St")
	})
})
