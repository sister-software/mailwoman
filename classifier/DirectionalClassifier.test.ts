/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DirectionalClassification } from "mailwoman/classification"
import test from "tape"
import { Span } from "../tokenization/Span.js"
import DirectionalClassifier from "./DirectionalClassifier.js"

const classifier = new DirectionalClassifier()

test("contains numerals: honours contains.numerals boolean", (t) => {
	const span = new Span("example")
	span.contains.numerals = true
	classifier.each(span)
	t.deepEqual(span.classifications, {})
	t.end()
})

type DirectionalTestCaseRecord = {
	valid: string[]
	invalid: string[]
}

const testCasesByLangauge = new Map<string, DirectionalTestCaseRecord>([
	[
		"English",
		{
			valid: [
				"north",
				"n",
				"n.",
				"south",
				"s",
				"s.",
				"east",
				"e",
				"e.",
				"west",
				"w",
				"w.",
				"northeast",
				"ne",
				"ne.",
				"southeast",
				"se",
				"se.",
				"northwest",
				"nw",
				"nw.",
				"southwest",
				"sw",
				"sw.",
				"lower",
				"lwr",
				"upper",
				"upr",
				"middle",
				"mdl",
				"centre",
				"center",
				"ctr",
				"central",
				"ctrl",
			],

			invalid: ["northsouth", "ns", "ns.", "westeast", "we", "we."],
		},
	],
	[
		"Spanish",
		{
			valid: [
				"norte",
				"n",
				"n.",
				"sur",
				"s",
				"s.",
				"este",
				"e",
				"e.",
				"oeste",
				"w",
				"w.",
				"noreste",
				"ne",
				"ne.",
				"sureste",
				"se",
				"se.",
				"noroeste",
				"nw",
				"nw.",
				"suroeste",
				"sw",
				"sw.",
			],

			invalid: ["norsur", "ns", "ns.", "oesteeste", "we", "we."],
		},
	],

	[
		"German",
		{
			valid: [
				"nord",
				"n",
				"n.",
				"süd",
				"s",
				"s.",
				"ost",
				"o",
				"o.",
				"west",
				"w",
				"w.",
				"nordost",
				"no",
				"no.",
				"südost",
				"so",
				"so.",
				"nordwest",
				"nw",
				"nw.",
				"südwest",
				"sw",
				"sw.",
			],

			invalid: ["nordsüd", "ns", "ns.", "westost", "wo", "wo."],
		},
	],
	[
		"French",
		{
			valid: [
				"nord",
				"n",
				"n.",
				"sud",
				"s",
				"s.",
				"est",
				"e",
				"e.",
				"ouest",
				"o",
				"o.",
				"nord est",
				"ne",
				"ne.",
				"sud est",
				"se",
				"se.",
				"nord ouest",
				"no",
				"no.",
				"sud ouest",
				"so",
				"so.",
			],

			invalid: ["nordsud", "ns", "ns.", "ouestest", "oe", "oe."],
		},
	],
])

for (const [language, cases] of testCasesByLangauge) {
	for (const token of cases.valid) {
		test(`${language}: ${token}`, (t) => {
			const span = classifier.classify(token)
			t.deepEqual(span.classifications, { DirectionalClassification: new DirectionalClassification(1.0) })
			t.end()
		})
	}

	for (const token of cases.invalid) {
		test(`${language}: ${token}`, (t) => {
			const span = classifier.classify(token)
			t.deepEqual(span.classifications, {})
			t.end()
		})
	}
}
