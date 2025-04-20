// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { ClassificationsMatchMap } from "mailwoman/core"
import { expect, test } from "vitest"
import { OrdinalClassifier } from "./OrdinalClassifier.js"

const classifier = new OrdinalClassifier()

test("English: single digit", () => {
	const span = classifier.classify("1st")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("ordinal"))
})

test("English: multiple digits", () => {
	const span = classifier.classify("250th")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("ordinal"))
})

test("English: single digit", () => {
	const span = classifier.classify("1rd")
	expect(span.classifications.size).toEqual(0)
})

test("English: multiple digits", () => {
	const span = classifier.classify("250nd")
	expect(span.classifications.size).toEqual(0)
})
