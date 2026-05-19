/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertCongruent } from "mailwoman/sdk/test"
import { expect, test } from "vitest"
import { TokenContext } from "./context.js"

test("constructor: basic", () => {
	const context = new TokenContext("100 Main Street")

	expect(context.span.body).toEqual("100 Main Street")
	expect(context.solutions.length, "No solutions").toEqual(0)
})

test("constructor: advanced", () => {
	const context = new TokenContext("100 West 26th Street, NYC, 10010 NY, USA")

	expect(context.span.body).toEqual("100 West 26th Street, NYC, 10010 NY, USA")
	expect(context.solutions.length, "No solutions").toEqual(0)
})

test("segment: basic", () => {
	const context = new TokenContext("100 Main Street")

	assertCongruent(
		context.sections.map((section) => section.phrases.pluck("body")),
		[
			// Section 0
			"100 Main Street",
			"100 Main",
			"100",
			"Main Street",
			"Main",
			"Street",
		]
	)
})

test("segment: advanced", () => {
	const context = new TokenContext("100 West 26th Street, NYC, 10010 NY, USA")

	assertCongruent(
		context.sections.map((section) => section.phrases.pluck("body")),
		[
			// Section 0
			"100 West 26th Street",
			"100 West 26th",
			"100 West",
			"100",
			"West 26th Street",
			"West 26th",
			"West",
			"26th Street",
			"26th",
			"Street",
		],
		[
			// Section 1
			"NYC",
		],
		[
			// Section 2
			"10010 NY",
			"10010",
			"NY",
		],
		[
			// Section 3
			"USA",
		]
	)
})

test("split: basic", () => {
	const context = new TokenContext("100 Main Street")

	assertCongruent(
		context.sections.map((section) => section.children.pluck("body")),
		["100", "Main", "Street"]
	)
})

test("split: advanced", () => {
	const context = new TokenContext("100 West 26th Street, NYC, 10010 NY, USA")

	assertCongruent(
		context.sections.map((section) => section.children.pluck("body")),

		[
			// Section 0 children
			"100",
			"West",
			"26th",
			"Street",
		],
		[
			// Section 1 children
			"NYC",
		],
		[
			// Section 2 children
			"10010",
			"NY",
		],
		[
			// Section 3 children
			"USA",
		]
	)
})

test("split: hyphen", () => {
	const context = new TokenContext("20 Boulevard Saint-Germain, Paris, France")

	assertCongruent(
		context.sections.map((section) => section.children.pluck("body")),
		["20", "Boulevard", "Saint-Germain", "Saint", "Germain"],
		["Paris"],
		["France"]
	)
})

test("permute: basic", () => {
	const context = new TokenContext("100 Main Street")

	assertCongruent(
		context.sections.map((section) => section.phrases.pluck("body")),
		[
			// Section 0
			"100 Main Street",
			"100 Main",
			"100",
			"Main Street",
			"Main",
			"Street",
		]
	)
})

test("permute: advanced", () => {
	const context = new TokenContext("100 West 26th Street, NYC, 10010 NY, USA")

	assertCongruent(
		context.sections.map((section) => section.phrases.pluck("body")),
		[
			"100 West 26th Street",
			"100 West 26th",
			"100 West",
			"100",
			"West 26th Street",
			"West 26th",
			"West",
			"26th Street",
			"26th",
			"Street",
		],
		["NYC"],
		["10010 NY", "10010", "NY"],
		["USA"]
	)
})

test("computeCoverage: basic", () => {
	const context = new TokenContext("100 Main Street")

	expect(context.toJSON().coverage).toEqual(13)
})

test("computeCoverage: advanced", () => {
	const context = new TokenContext("100 West 26th Street, NYC, 10010 NY, USA")
	expect(context.toJSON().coverage).toEqual(30)
})

test("computeCoverage: trim text when greater than 140 characters with spaces", () => {
	const context =
		new TokenContext(`Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
      Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.`)
	const { coverage } = context.toJSON()

	expect(coverage).toBeLessThan(140)
	expect(coverage).toEqual(111)
})

test("computeCoverage: do not trim text when it's 140 characters", () => {
	const exact =
		"LoremipsumdolorsitametconsecteturadipiscingelitseddoeiusmodtemporincididuntutlaboreetdoloremagnaaliquaUtenimadminimveniamquisnostrudexercita"
	const context = new TokenContext(exact)
	expect(context.toJSON().coverage).toEqual(140)
})
