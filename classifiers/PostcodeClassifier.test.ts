/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ClassificationsMatchMap } from "@mailwoman/core"
import { expect, test } from "vitest"

import { PostcodeClassifier } from "./PostcodeClassifier.ts"

const classifier = await new PostcodeClassifier().ready()

test("classify: USA ZIP", () => {
	const span = classifier.classify("10010")

	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("postcode"))
})

test("classify: USA ZIP Plus 4", () => {
	const span = classifier.classify("99577-0727")

	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("postcode"))
})

test("classify: DEU", () => {
	const span = classifier.classify("10117")

	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("postcode"))
})

test("classify: NZD", () => {
	const span = classifier.classify("6012")

	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("postcode"))
})

test("classify: AUD", () => {
	const span = classifier.classify("2000")

	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("postcode"))
})

test("classify: FRA", () => {
	const span = classifier.classify("75000")

	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("postcode"))
})

test("classify: GBP", () => {
	const span = classifier.classify("E81DN")

	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("postcode"))
})

test("classify: JAP", () => {
	const span = classifier.classify("100-0000")

	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("postcode"))
})

test("classify: RUS", () => {
	const span = classifier.classify("101000")

	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("postcode"))
})

test("classify: BRA", () => {
	const span = classifier.classify("18180-000")

	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("postcode"))
})

test("classify: NLD", () => {
	const span = classifier.classify("7512EC")

	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("postcode"))
})
