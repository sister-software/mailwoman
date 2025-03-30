// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { ClassificationsMatchMap } from "mailwoman/core"
import test from "tape"
import { PostcodeClassifier } from "./PostcodeClassifier.js"

const classifier = await new PostcodeClassifier().ready()

test("classify: USA ZIP", (t) => {
	const span = classifier.classify("10010")

	t.same(span.classifications, ClassificationsMatchMap.from("postcode"))
	t.end()
})

test("classify: USA ZIP Plus 4", (t) => {
	const span = classifier.classify("99577-0727")

	t.same(span.classifications, ClassificationsMatchMap.from("postcode"))
	t.end()
})

test("classify: DEU", (t) => {
	const span = classifier.classify("10117")

	t.same(span.classifications, ClassificationsMatchMap.from("postcode"))
	t.end()
})

test("classify: NZD", (t) => {
	const span = classifier.classify("6012")

	t.same(span.classifications, ClassificationsMatchMap.from("postcode"))
	t.end()
})

test("classify: AUD", (t) => {
	const span = classifier.classify("2000")

	t.same(span.classifications, ClassificationsMatchMap.from("postcode"))
	t.end()
})

test("classify: FRA", (t) => {
	const span = classifier.classify("75000")

	t.same(span.classifications, ClassificationsMatchMap.from("postcode"))
	t.end()
})

test("classify: GBP", (t) => {
	const span = classifier.classify("E81DN")

	t.same(span.classifications, ClassificationsMatchMap.from("postcode"))
	t.end()
})

test("classify: JAP", (t) => {
	const span = classifier.classify("100-0000")

	t.same(span.classifications, ClassificationsMatchMap.from("postcode"))
	t.end()
})

test("classify: RUS", (t) => {
	const span = classifier.classify("101000")

	t.same(span.classifications, ClassificationsMatchMap.from("postcode"))
	t.end()
})

test("classify: BRA", (t) => {
	const span = classifier.classify("18180-000")

	t.same(span.classifications, ClassificationsMatchMap.from("postcode"))
	t.end()
})

test("classify: NLD", (t) => {
	const span = classifier.classify("7512EC")

	t.same(span.classifications, ClassificationsMatchMap.from("postcode"))
	t.end()
})
