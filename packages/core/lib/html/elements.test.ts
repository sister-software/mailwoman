/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { childElement, childElements, elementAtPath, streamMarkupElements, textAtPath } from "#html/elements"

/**
 * Two INSPIRE address features, trimmed from the shape Czechia publishes.
 *
 * The second one repeats `ad:designator` with two different types and carries a nil element,
 * which are the two things a text-only reader cannot tell apart.
 */
const GML = `<?xml version="1.0" encoding="UTF-8"?>
<base:SpatialDataSet xmlns:base="http://inspire.ec.europa.eu/schemas/base/3.3" xmlns:ad="http://inspire.ec.europa.eu/schemas/ad/4.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
	<base:member>
		<ad:Address gml:id="AD.1">
			<ad:alternativeIdentifier>Komenského 1, 66701 Židlochovice</ad:alternativeIdentifier>
			<ad:locator>
				<ad:AddressLocator>
					<ad:designator>
						<ad:LocatorDesignator>
							<ad:designator>č.ev.</ad:designator>
							<ad:type xlink:href="http://inspire.ec.europa.eu/codelist/LocatorDesignatorTypeValue/buildingIdentifierPrefix" xlink:title="buildingIdentifierPrefix" />
						</ad:LocatorDesignator>
					</ad:designator>
					<ad:designator>
						<ad:LocatorDesignator>
							<ad:designator>502</ad:designator>
							<ad:type xlink:href="http://inspire.ec.europa.eu/codelist/LocatorDesignatorTypeValue/buildingIdentifier" xlink:title="buildingIdentifier" />
						</ad:LocatorDesignator>
					</ad:designator>
				</ad:AddressLocator>
			</ad:locator>
			<ad:endLifespanVersion xsi:nil="true" nilReason="http://inspire.ec.europa.eu/codelist/VoidReasonValue/Unpopulated" />
			<ad:component xlink:href="http://x/?Id=AU.1.1" xlink:title="Česká Republika" />
			<ad:component xlink:href="http://x/?Id=TF.48674" xlink:title="Komenského" />
			<ad:component xlink:href="http://x/?Id=PD.66701" xlink:title="66701" />
		</ad:Address>
	</base:member>
	<base:member>
		<ad:Address gml:id="AD.2">
			<ad:alternativeIdentifier />
			<ad:component xlink:href="http://x/?Id=AU.1.1" xlink:title="Česká Republika" />
		</ad:Address>
	</base:member>
</base:SpatialDataSet>`

async function* once(text: string): AsyncIterable<string> {
	yield text
}

/**
 * The same document delivered one byte at a time, which splits every multi-byte character.
 */
async function* perByte(text: string): AsyncIterable<Uint8Array> {
	const bytes = new TextEncoder().encode(text)

	for (const byte of bytes) {
		yield new Uint8Array([byte])
	}
}

async function collect(chunks: AsyncIterable<string | Uint8Array>, name = "ad:Address") {
	return await Array.fromAsync(streamMarkupElements(chunks, name, { xml: true }))
}

describe("streamMarkupElements", () => {
	it("yields each named element once, in document order", async () => {
		const addresses = await collect(once(GML))

		expect(addresses.map((a) => a.attributes["gml:id"])).toEqual(["AD.1", "AD.2"])
	})

	it("reads a namespaced attribute, which document.ts reads only on the root", async () => {
		const [first] = await collect(once(GML))

		expect(childElement(first!, "ad:component")?.attributes["xlink:title"]).toBe("Česká Republika")
	})

	it("keeps repeated same-name children separate, which elementTexts flattens", async () => {
		const [first] = await collect(once(GML))
		const locator = elementAtPath(first!, "ad:locator", "ad:AddressLocator")
		const designators = childElements(locator!, "ad:designator")

		expect(designators).toHaveLength(2)

		const read = designators.map((d) => {
			const inner = childElement(d, "ad:LocatorDesignator")!

			return [textAtPath(inner, "ad:designator"), childElement(inner, "ad:type")?.attributes["xlink:title"]]
		})

		expect(read).toEqual([
			["č.ev.", "buildingIdentifierPrefix"],
			["502", "buildingIdentifier"],
		])
	})

	it("reads a void element's nil marker and its reason", async () => {
		const [first] = await collect(once(GML))
		const nil = childElement(first!, "ad:endLifespanVersion")!

		expect(nil.attributes["xsi:nil"]).toBe("true")
		expect(nil.attributes.nilReason).toBe("http://inspire.ec.europa.eu/codelist/VoidReasonValue/Unpopulated")
		expect(nil.text).toBe("")
	})

	it("distinguishes an element written empty from one the document omits", async () => {
		const [, second] = await collect(once(GML))

		// The publisher wrote `<ad:alternativeIdentifier />`, so the value is present and blank.
		expect(textAtPath(second!, "ad:alternativeIdentifier")).toBe("")
		// It wrote no locator at all.
		expect(textAtPath(second!, "ad:locator")).toBeUndefined()
		expect(elementAtPath(second!, "ad:locator", "ad:AddressLocator")).toBeUndefined()
	})

	it("keeps a child's text out of its parent's text", async () => {
		const [first] = await collect(once(GML))

		expect(first!.text).toBe("")
		expect(textAtPath(first!, "ad:alternativeIdentifier")).toBe("Komenského 1, 66701 Židlochovice")
	})

	it("survives a multi-byte character split across chunks", async () => {
		const addresses = await collect(perByte(GML))

		expect(addresses).toHaveLength(2)
		expect(textAtPath(addresses[0]!, "ad:alternativeIdentifier")).toBe("Komenského 1, 66701 Židlochovice")
		expect(childElement(addresses[1]!, "ad:component")?.attributes["xlink:title"]).toBe("Česká Republika")
	})

	it("yields the outermost occurrence once when the same name nests", async () => {
		const nested = `<r><a id="outer"><b/><a id="inner"><c/></a></a><a id="second"/></r>`
		const found = await Array.fromAsync(streamMarkupElements(once(nested), "a", { xml: true }))

		expect(found.map((e) => e.attributes.id)).toEqual(["outer", "second"])
		expect(childElement(found[0]!, "a")?.attributes.id).toBe("inner")
	})

	it("yields the elements a whole document contains when nothing matches", async () => {
		expect(await collect(once(GML), "ad:Parcel")).toEqual([])
	})

	it("stops at a chunk boundary when the caller aborts", async () => {
		const controller = new AbortController()
		const found = []

		for await (const element of streamMarkupElements(perByte(GML), "ad:Address", {
			xml: true,
			signal: controller.signal,
		})) {
			found.push(element)
			controller.abort()
		}

		expect(found).toHaveLength(1)
		expect(found[0]!.attributes["gml:id"]).toBe("AD.1")
	})

	it("reads an element whose text arrives across several chunks", async () => {
		async function* split(): AsyncIterable<string> {
			yield `<r><ad:Address xmlns:ad="x"><ad:v>Kome`
			yield `nského `
			yield `502</ad:v></ad:Address></r>`
		}

		const [only] = await Array.fromAsync(streamMarkupElements(split(), "ad:Address", { xml: true }))

		expect(textAtPath(only!, "ad:v")).toBe("Komenského 502")
	})
})

describe("childElements and elementAtPath", () => {
	it("returns every match and the first match respectively", async () => {
		const [first] = await collect(once(GML))

		expect(childElements(first!, "ad:component")).toHaveLength(3)
		expect(childElement(first!, "ad:component")?.attributes["xlink:title"]).toBe("Česká Republika")
	})

	it("returns undefined at the first absent step rather than throwing", async () => {
		const [first] = await collect(once(GML))

		expect(elementAtPath(first!, "ad:locator", "ad:Missing", "ad:designator")).toBeUndefined()
		expect(textAtPath(first!, "ad:nowhere")).toBeUndefined()
	})
})
