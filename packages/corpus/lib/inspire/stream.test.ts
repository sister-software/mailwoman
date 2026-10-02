/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { MarkupElement } from "@mailwoman/core/html/elements"
import { describe, expect, it } from "vitest"

import { streamInspireRows } from "#inspire/stream"
import type { CanonicalRow } from "#types"

const NS =
	'xmlns:ad="http://inspire.ec.europa.eu/schemas/ad/4.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:xlink="http://www.w3.org/1999/xlink"'

/**
 * A document whose referenced feature arrives after the address that names it.
 *
 * Czechia interleaves the two, so an address can reach a reader before its street.
 */
const STREET_AFTER = `<r ${NS}>
	<ad:Address gml:id="AD.1"><ad:component xlink:href="#TF.1" /></ad:Address>
	<ad:ThoroughfareName gml:id="TF.1" />
	<ad:Address gml:id="AD.2"><ad:component xlink:href="#TF.1" /></ad:Address>
</r>`

/**
 * A document whose referenced features all precede the addresses, as the Netherlands writes one.
 */
const STREET_FIRST = `<r ${NS}>
	<ad:ThoroughfareName gml:id="TF.1" />
	<ad:Address gml:id="AD.1"><ad:component xlink:href="#TF.1" /></ad:Address>
	<ad:Address gml:id="AD.2"><ad:component xlink:href="#TF.1" /></ad:Address>
	<ad:Address gml:id="AD.3"><ad:component xlink:href="#TF.404" /></ad:Address>
</r>`

async function* once(text: string): AsyncIterable<string> {
	yield text
}

/**
 * A row carrying only what these tests assert on.
 */
function row(id: string): CanonicalRow {
	return {
		raw: id,
		components: {},
		country: "CZ",
		locale: "cs-CZ",
		source: "test",
		source_id: id,
		corpus_version: "",
		license: "CC0-1.0",
	}
}

/**
 * The shape both rewired adapters use: resolve every reference, holding
 * while the document runs and refusing once it has ended.
 */
function composeResolvingAll(
	address: MarkupElement,
	referenced: ReadonlyMap<string, string>,
	final: boolean
): CanonicalRow | undefined | "deferred" {
	const hrefs = address.children.filter((c) => c.name === "ad:component").map((c) => c.attributes["xlink:href"] ?? "")

	for (const href of hrefs) {
		if (!referenced.has(href.replace("#", ""))) return final ? undefined : "deferred"
	}

	return row(address.attributes["gml:id"]!)
}

describe("streamInspireRows", () => {
	it("holds an address whose reference the pass has not reached, and answers it at the end", async () => {
		const rows = await Array.fromAsync(
			streamInspireRows<string>({
				chunks: once(STREET_AFTER),
				componentElements: ["ad:ThoroughfareName"],
				index: (feature) => feature.attributes["gml:id"] ?? "",
				compose: composeResolvingAll,
			})
		)

		// `AD.2` arrives after the street and is emitted in document order.
		// `AD.1` was held, so it arrives last rather than being refused for a reference the document did carry.
		expect(rows.map((r) => r.source_id)).toEqual(["AD.2", "AD.1"])
	})

	it("refuses a held address whose reference the document never carried", async () => {
		const rows = await Array.fromAsync(
			streamInspireRows<string>({
				chunks: once(STREET_FIRST),
				componentElements: ["ad:ThoroughfareName"],
				index: (feature) => feature.attributes["gml:id"] ?? "",
				compose: composeResolvingAll,
			})
		)

		// `AD.3` names `TF.404`, which no feature answers, so it is refused once the document ends.
		expect(rows.map((r) => r.source_id)).toEqual(["AD.1", "AD.2"])
	})

	it("tells the composer whether the document has ended", async () => {
		const seen: Array<readonly [string, boolean]> = []

		await Array.fromAsync(
			streamInspireRows<string>({
				chunks: once(STREET_AFTER),
				componentElements: ["ad:ThoroughfareName"],
				index: (feature) => feature.attributes["gml:id"] ?? "",
				compose: (address, referenced, final) => {
					seen.push([address.attributes["gml:id"]!, final])

					return composeResolvingAll(address, referenced, final)
				},
			})
		)

		// `AD.1` is asked twice, once while the document runs and once after it ends.
		expect(seen).toEqual([
			["AD.1", false],
			["AD.2", false],
			["AD.1", true],
		])
	})

	it("stops at the limit, counting held rows against it", async () => {
		const rows = await Array.fromAsync(
			streamInspireRows<string>({
				chunks: once(STREET_FIRST),
				componentElements: ["ad:ThoroughfareName"],
				index: (feature) => feature.attributes["gml:id"] ?? "",
				compose: composeResolvingAll,
				limit: 1,
			})
		)

		expect(rows.map((r) => r.source_id)).toEqual(["AD.1"])
	})

	it("yields no row for a caller that aborted before the read", async () => {
		const controller = new AbortController()

		controller.abort()

		const rows = await Array.fromAsync(
			streamInspireRows<string>({
				chunks: once(STREET_FIRST),
				componentElements: ["ad:ThoroughfareName"],
				index: (feature) => feature.attributes["gml:id"] ?? "",
				compose: composeResolvingAll,
				signal: controller.signal,
			})
		)

		expect(rows).toEqual([])
	})

	it("keeps what the caller indexes rather than the subtree", async () => {
		const kept: string[] = []

		await Array.fromAsync(
			streamInspireRows<string>({
				chunks: once(STREET_FIRST),
				componentElements: ["ad:ThoroughfareName"],
				index: (feature) => {
					kept.push(feature.name)

					return "indexed"
				},
				compose: (address, referenced) => {
					expect(referenced.get("TF.1")).toBe("indexed")

					return row(address.attributes["gml:id"]!)
				},
			})
		)

		expect(kept).toEqual(["ad:ThoroughfareName"])
	})

	it("skips a referenced feature carrying no key, which no address can name", async () => {
		const keyless = `<r ${NS}><ad:ThoroughfareName /><ad:Address gml:id="AD.1" /></r>`
		const seen: Array<ReadonlyMap<string, string>> = []

		await Array.fromAsync(
			streamInspireRows<string>({
				chunks: once(keyless),
				componentElements: ["ad:ThoroughfareName"],
				index: () => "indexed",
				compose: (address, referenced) => {
					seen.push(referenced)

					return row(address.attributes["gml:id"]!)
				},
			})
		)

		expect(seen[0]?.size).toBe(0)
	})

	it("refuses a row the composer defers after the document ended, rather than holding it again", async () => {
		const rows = await Array.fromAsync(
			streamInspireRows<string>({
				chunks: once(STREET_FIRST),
				componentElements: ["ad:ThoroughfareName"],
				index: (feature) => feature.attributes["gml:id"] ?? "",
				// A composer that ignores `final` would otherwise be asked forever.
				compose: () => "deferred",
			})
		)

		expect(rows).toEqual([])
	})
})
