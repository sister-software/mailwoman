/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"
import type { BioLabel } from "../types/component.js"
import { buildAddressTree } from "./build-tree.js"
import { decodeAsJson } from "./serialize-json.js"
import { decodeAsTuples } from "./serialize-tuples.js"
import { decodeAsXml } from "./serialize-xml.js"
import type { DecoderToken } from "./types.js"

function tok(piece: string, start: number, end: number, label: BioLabel, confidence = 1): DecoderToken {
	return { piece, start, end, label, confidence }
}

const WHITE_HOUSE_RAW = "1600 Pennsylvania Avenue NW, Washington, DC 20500"
const WHITE_HOUSE_TOKENS: DecoderToken[] = [
	tok("1600", 0, 4, "B-house_number"),
	tok("Pennsylvania", 5, 17, "B-street"),
	tok("Avenue", 18, 24, "I-street"),
	tok("NW", 25, 27, "I-street"),
	tok(",", 27, 28, "O"),
	tok("Washington", 29, 39, "B-locality"),
	tok(",", 39, 40, "O"),
	tok("DC", 41, 43, "B-region"),
	tok("20500", 44, 49, "B-postcode"),
]

describe("decodeAsJson (libpostal-compat)", () => {
	test("flattens to a tag→value map", () => {
		const tree = buildAddressTree(WHITE_HOUSE_RAW, WHITE_HOUSE_TOKENS)
		expect(decodeAsJson(tree)).toEqual({
			house_number: "1600",
			street: "Pennsylvania Avenue NW",
			locality: "Washington",
			region: "DC",
			postcode: "20500",
		})
	})

	test("first-occurrence wins for repeated tags", () => {
		// "Springfield IL Springfield MA" → two B-locality
		const raw = "Springfield IL Springfield MA"
		const tokens: DecoderToken[] = [
			tok("Springfield", 0, 11, "B-locality"),
			tok("IL", 12, 14, "B-region"),
			tok("Springfield", 15, 26, "B-locality"),
			tok("MA", 27, 29, "B-region"),
		]
		const tree = buildAddressTree(raw, tokens)
		const json = decodeAsJson(tree)
		// First locality / region encountered in tree walk wins.
		expect(json.locality).toBeDefined()
		expect(json.region).toBeDefined()
	})
})

describe("decodeAsTuples (order-preserving)", () => {
	test("returns spans in source order", () => {
		const tree = buildAddressTree(WHITE_HOUSE_RAW, WHITE_HOUSE_TOKENS)
		expect(decodeAsTuples(tree)).toEqual([
			["house_number", "1600"],
			["street", "Pennsylvania Avenue NW"],
			["locality", "Washington"],
			["region", "DC"],
			["postcode", "20500"],
		])
	})

	test("preserves repetition", () => {
		const raw = "Springfield IL Springfield MA"
		const tokens: DecoderToken[] = [
			tok("Springfield", 0, 11, "B-locality"),
			tok("IL", 12, 14, "B-region"),
			tok("Springfield", 15, 26, "B-locality"),
			tok("MA", 27, 29, "B-region"),
		]
		const tree = buildAddressTree(raw, tokens)
		const tuples = decodeAsTuples(tree)
		expect(tuples.filter(([t]) => t === "locality").length).toBe(2)
		expect(tuples.filter(([t]) => t === "region").length).toBe(2)
	})
})

describe("decodeAsXml (nested mixed-content)", () => {
	test("emits root <address> with @raw and nested components with @start/@end/@conf", () => {
		const tree = buildAddressTree(WHITE_HOUSE_RAW, WHITE_HOUSE_TOKENS)
		const xml = decodeAsXml(tree)
		// Root attribute carries the raw input.
		expect(xml).toContain(`<address raw="1600 Pennsylvania Avenue NW, Washington, DC 20500">`)
		// Region wraps locality wraps street/postcode.
		expect(xml).toContain(`<region start="41" end="43" conf="1.00">DC`)
		expect(xml).toContain(`<locality start="29" end="39" conf="1.00">Washington`)
		expect(xml).toContain(`<street start="5" end="27" conf="1.00">Pennsylvania Avenue NW`)
		expect(xml).toContain(`<house_number start="0" end="4" conf="1.00">1600</house_number>`)
		expect(xml).toContain(`<postcode start="44" end="49" conf="1.00">20500</postcode>`)
		// Closing tags balance.
		expect(xml).toContain(`</street>`)
		expect(xml).toContain(`</locality>`)
		expect(xml).toContain(`</region>`)
		expect(xml).toContain(`</address>`)
	})

	test("escapes XML special chars in @raw and component values", () => {
		const raw = `<dangerous & "quoted">`
		const tokens: DecoderToken[] = [tok(raw, 0, raw.length, "B-locality")]
		const tree = buildAddressTree(raw, tokens)
		const xml = decodeAsXml(tree)
		// @raw is untouched by the decoder — full input must escape.
		expect(xml).toContain(`raw="&lt;dangerous &amp; &quot;quoted&quot;&gt;"`)
		expect(xml).not.toContain(`raw="<dangerous`)
		// node.value is trimmed past the leading `<` and trailing `>` (boundary-trim in
		// buildAddressTree), so the locality body is `dangerous & "quoted` — still contains `&` and
		// `"`, exercising the in-body escaping path.
		expect(xml).toContain(`>dangerous &amp; &quot;quoted<`)
	})

	test("respects opts: includeOffsets=false drops start/end attrs", () => {
		const tree = buildAddressTree(WHITE_HOUSE_RAW, WHITE_HOUSE_TOKENS)
		const xml = decodeAsXml(tree, { includeOffsets: false })
		expect(xml).not.toContain(`start=`)
		expect(xml).not.toContain(`end=`)
		expect(xml).toContain(`conf="1.00"`)
	})

	test("respects opts: includeConf=false drops conf attrs", () => {
		const tree = buildAddressTree(WHITE_HOUSE_RAW, WHITE_HOUSE_TOKENS)
		const xml = decodeAsXml(tree, { includeConf: false })
		expect(xml).not.toContain(`conf=`)
		expect(xml).toContain(`start=`)
	})

	test("opts: pretty=false emits a single line", () => {
		const tree = buildAddressTree(WHITE_HOUSE_RAW, WHITE_HOUSE_TOKENS)
		const xml = decodeAsXml(tree, { pretty: false })
		expect(xml.includes("\n")).toBe(false)
		expect(xml.includes("\t")).toBe(false)
	})

	test("well-formed: every opened tag closes", () => {
		const tree = buildAddressTree(WHITE_HOUSE_RAW, WHITE_HOUSE_TOKENS)
		const xml = decodeAsXml(tree)
		const openers = [...xml.matchAll(/<([a-z_]+)(?:\s[^>]*)?>/g)].map((m) => m[1])
		const closers = [...xml.matchAll(/<\/([a-z_]+)>/g)].map((m) => m[1])
		// Self-closing tags would shorten the closer list; we don't emit any, so they should match.
		expect(openers.sort()).toEqual(closers.sort())
	})

	test("includeAlternatives=false by default (libpostal-compat preserved)", () => {
		const raw = "Springfield"
		const tokens: DecoderToken[] = [tok("Springfield", 0, 11, "B-locality")]
		const tree = buildAddressTree(raw, tokens)
		const root = tree.roots[0]!
		root.alternatives = [
			{ id: 101727113, name: "Springfield, IL", placetype: "locality", lat: 39.78, lon: -89.65, score: 8 },
			{ id: 101728010, name: "Springfield, MO", placetype: "locality", lat: 37.21, lon: -93.29, score: 7 },
		]
		const xml = decodeAsXml(tree)
		expect(xml).not.toContain("<alternative")
		expect(xml).not.toContain("Springfield, IL")
	})

	test("includeAlternatives=true emits self-closing <alternative> per runner-up", () => {
		const raw = "Springfield"
		const tokens: DecoderToken[] = [tok("Springfield", 0, 11, "B-locality")]
		const tree = buildAddressTree(raw, tokens)
		const root = tree.roots[0]!
		root.alternatives = [
			{ id: 101727113, name: "Springfield, IL", placetype: "locality", lat: 39.78, lon: -89.65, score: 8 },
			{ id: 101728010, name: "Springfield, MO", placetype: "locality", lat: 37.21, lon: -93.29, score: 7 },
		]
		const xml = decodeAsXml(tree, { includeAlternatives: true })
		expect(xml).toContain("<alternative")
		expect(xml).toContain('place="wof:101727113"')
		expect(xml).toContain('name="Springfield, IL"')
		expect(xml).toContain('placetype="locality"')
		expect(xml).toContain('lat="39.780000"')
		expect(xml).toContain('lon="-89.650000"')
		expect(xml).toContain('score="8.000"')
		expect(xml).toContain('place="wof:101728010"')
		// Self-closing form (no </alternative> closer).
		expect(xml).not.toContain("</alternative>")
	})

	test("includeAlternatives is a no-op when node has no alternatives", () => {
		const tree = buildAddressTree(WHITE_HOUSE_RAW, WHITE_HOUSE_TOKENS)
		const xml = decodeAsXml(tree, { includeAlternatives: true })
		expect(xml).not.toContain("<alternative")
		// Existing structure still well-formed.
		expect(xml).toContain("<address raw=")
	})
})

describe("interpretations (multi-role nodes, #413)", () => {
	// A city-state: the `region` span "Berlin" also plays `locality` via an interpretation.
	const cityStateTree = () => {
		const tree = buildAddressTree("Berlin 10115", [tok("Berlin", 0, 6, "B-region"), tok("10115", 7, 12, "B-postcode")])
		const region = tree.roots.find((r) => r.tag === "region")!
		;(region as { interpretations?: unknown }).interpretations = [
			{ tag: "locality", placeId: "wof:101909779", lat: 52.52, lon: 13.4 },
		]
		return tree
	}

	test("decodeAsJson emits one entry per role — region AND locality both surface", () => {
		expect(decodeAsJson(cityStateTree())).toMatchObject({ region: "Berlin", locality: "Berlin", postcode: "10115" })
	})

	test("decodeAsJson is byte-stable when no interpretations are present", () => {
		const tree = buildAddressTree("Berlin 10115", [tok("Berlin", 0, 6, "B-region"), tok("10115", 7, 12, "B-postcode")])
		expect(decodeAsJson(tree)).toEqual({ region: "Berlin", postcode: "10115" })
	})

	test("decodeAsXml lists the roles, primary first", () => {
		const xml = decodeAsXml(cityStateTree())
		expect(xml).toContain('roles="region locality"')
	})

	test("decodeAsXml emits no roles attribute on a single-role node", () => {
		const tree = buildAddressTree("Berlin 10115", [tok("Berlin", 0, 6, "B-region"), tok("10115", 7, 12, "B-postcode")])
		expect(decodeAsXml(tree)).not.toContain("roles=")
	})
})
