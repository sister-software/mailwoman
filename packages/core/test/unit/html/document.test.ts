/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { elementText, elementTexts, rootAttribute, sliceDocument } from "@mailwoman/core/html/document"
import { describe, expect, it } from "vitest"

describe("sliceDocument", () => {
	it("narrows to an envelope element's payload", () => {
		expect(sliceDocument("<a>before<TEXT><p>body</p></TEXT>after</a>", { within: "text" })).toBe("<p>body</p>")
	})

	it("leaves a document that states no such envelope whole", () => {
		expect(sliceDocument("<p>body</p>", { within: "text" })).toBe("<p>body</p>")
	})

	it("removes the named elements after narrowing, so envelope metadata never answers for the payload", () => {
		const html = "<text><head><title>filename.htm</title></head><p>body</p><script>x=1</script></text>"

		expect(sliceDocument(html, { within: "text", without: ["head", "script"] })).toBe("<p>body</p>")
	})

	it("removes a nested match, not only a direct child", () => {
		expect(sliceDocument("<div><p>a<style>b{}</style></p></div>", { without: ["style"] })).toBe("<div><p>a</p></div>")
	})
})

describe("elementTexts", () => {
	it("reads every element of that name in document order", () => {
		const xml = "<r><Prefix>release/a/</Prefix><Prefix>release/b/</Prefix></r>"

		expect(elementTexts(xml, "Prefix", { xml: true })).toEqual(["release/a/", "release/b/"])
	})

	it("ignores a namespace prefix, which is the publisher's alias rather than the contract", () => {
		expect(
			elementTexts("<r><gco:CharacterString>x</gco:CharacterString></r>", "CharacterString", { xml: true })
		).toEqual(["x"])
	})

	it("decodes entities and flattens nested markup to its text", () => {
		expect(elementText("<r><m>Smith &amp; <b>Sons</b></m></r>", "m", { xml: true })).toBe("Smith & Sons")
	})

	it("answers an empty list for an absent element, which is distinct from present and empty", () => {
		expect(elementTexts("<r></r>", "m", { xml: true })).toEqual([])
		expect(elementTexts("<r><m></m></r>", "m", { xml: true })).toEqual([""])
	})
})

describe("rootAttribute", () => {
	it("reads the attribute off the ROOT element", () => {
		expect(rootAttribute('<FeatureCollection numberMatched="42"/>', "numberMatched", { xml: true })).toBe("42")
	})

	it("does not let a nested member answer for the collection", () => {
		const xml = '<FeatureCollection><member numberMatched="7"/></FeatureCollection>'

		expect(rootAttribute(xml, "numberMatched", { xml: true })).toBeUndefined()
	})

	it("answers undefined when the root carries no such attribute", () => {
		expect(rootAttribute('<FeatureCollection timeStamp="2026-09-02"/>', "numberMatched", { xml: true })).toBeUndefined()
	})
})
