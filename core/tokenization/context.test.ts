// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assertCongruent } from "mailwoman/sdk/test"
import test from "tape"
import { TokenContext } from "./context.js"

test("constructor: basic", (t) => {
	const context = new TokenContext("100 Main Street")

	t.equals(context.span.body, "100 Main Street")
	t.equals(context.solutions.length, 0, "No solutions")

	t.end()
})

test("constructor: advanced", (t) => {
	const context = new TokenContext("100 West 26th Street, NYC, 10010 NY, USA")

	t.equals(context.span.body, "100 West 26th Street, NYC, 10010 NY, USA")
	t.equals(context.solutions.length, 0, "No solutions")
	t.end()
})

test("segment: basic", (t) => {
	const context = new TokenContext("100 Main Street")

	assertCongruent(
		t,
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
	t.end()
})

test("segment: advanced", (t) => {
	const context = new TokenContext("100 West 26th Street, NYC, 10010 NY, USA")

	assertCongruent(
		t,
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

	t.end()
})

test("split: basic", (t) => {
	const context = new TokenContext("100 Main Street")

	assertCongruent(
		t,
		context.sections.map((section) => section.children.pluck("body")),
		["100", "Main", "Street"]
	)

	t.end()
})

test("split: advanced", (t) => {
	const context = new TokenContext("100 West 26th Street, NYC, 10010 NY, USA")

	assertCongruent(
		t,
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

	t.end()
})

test("split: hyphen", (t) => {
	const context = new TokenContext("20 Boulevard Saint-Germain, Paris, France")

	// t.equals(context.sections.length, 3)
	// t.equals(section1?.children.size, 5)
	// t.equals(section1?.children[0]?.body, "20")
	// t.equals(section1?.children[1]?.body, "Boulevard")
	// t.equals(section1?.children[2]?.body, "Saint-Germain")
	// t.equals(section1?.children[3]?.body, "Saint")
	// t.equals(section1?.children[4]?.body, "Germain")
	// t.equals(section2?.children.size, 1)
	// t.equals(section2?.children[0]?.body, "Paris")
	// t.equals(section3.children.size, 1)
	// t.equals(section3.children[0]?.body, "France")

	assertCongruent(
		t,
		context.sections.map((section) => section.children.pluck("body")),
		["20", "Boulevard", "Saint-Germain", "Saint", "Germain"],
		["Paris"],
		["France"]
	)

	t.end()
})

test("permute: basic", (t) => {
	const context = new TokenContext("100 Main Street")

	assertCongruent(
		t,
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

	t.end()
})

test("permute: advanced", (t) => {
	const context = new TokenContext("100 West 26th Street, NYC, 10010 NY, USA")

	assertCongruent(
		t,
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

	t.end()
})

test("computeCoverage: basic", (t) => {
	const context = new TokenContext("100 Main Street")
	t.equal(13, context.toJSON().coverage)
	t.end()
})

test("computeCoverage: advanced", (t) => {
	const context = new TokenContext("100 West 26th Street, NYC, 10010 NY, USA")
	t.equal(30, context.toJSON().coverage)
	t.end()
})

test("computeCoverage: trim text when greater than 140 characters with spaces", (t) => {
	const context =
		new TokenContext(`Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
      Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.`)
	const { coverage } = context.toJSON()

	t.ok(coverage < 140)
	t.equal(coverage, 111)

	t.end()
})

test("computeCoverage: do not trim text when it's 140 characters", (t) => {
	const exact =
		"LoremipsumdolorsitametconsecteturadipiscingelitseddoeiusmodtemporincididuntutlaboreetdoloremagnaaliquaUtenimadminimveniamquisnostrudexercita"
	const context = new TokenContext(exact)
	t.equal(context.toJSON().coverage, 140)
	t.end()
})
