/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ClassificationsMatchMap } from "@mailwoman/core"
import { expect, test } from "vitest"

import { DirectionalClassifier } from "./DirectionalClassifier.ts"

const classifier = await new DirectionalClassifier().ready()

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
		test(`${language}: ${token}`, () => {
			const span = classifier.classify(token)

			expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("directional"))
		})
	}

	for (const token of cases.invalid) {
		test(`${language}: ${token}`, () => {
			const span = classifier.classify(token)
			expect(span.classifications.size).toEqual(0)
		})
	}
}
