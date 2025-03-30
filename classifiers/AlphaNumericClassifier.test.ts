// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { ClassificationsMatchMap } from "mailwoman/core"
import test from "tape"
import { AlphaNumericClassifier } from "./AlphaNumericClassifier.js"

const classifier = new AlphaNumericClassifier()

test("AlphaClassification: English letter", (t) => {
	const span = classifier.classify("A")
	t.same(span.classifications, ClassificationsMatchMap.from("alpha"))
	t.end()
})

test("AlphaClassification: English mixed-case word", (t) => {
	const span = classifier.classify("TesT ExAmPle")
	t.same(span.classifications, ClassificationsMatchMap.from("alpha"))
	t.end()
})

test("AlphaClassification: Japanese", (t) => {
	const span = classifier.classify("東京")
	t.same(span.classifications, ClassificationsMatchMap.from("alpha"))
	t.end()
})

test("AlphaClassification: Mandarin", (t) => {
	const span = classifier.classify("北京市")
	t.same(span.classifications, ClassificationsMatchMap.from("alpha"))
	t.end()
})

test("AlphaClassification: Cyrillic", (t) => {
	const span = classifier.classify("Москва́")
	t.same(span.classifications, ClassificationsMatchMap.from("alpha"))
	t.end()
})

test("NumericClassification: single digit", (t) => {
	const span = classifier.classify("1")
	t.same(span.classifications, ClassificationsMatchMap.from("numeric"))
	t.end()
})

test("NumericClassification: multiple digits", (t) => {
	const span = classifier.classify("1234567890")
	t.same(span.classifications, ClassificationsMatchMap.from("numeric"))
	t.end()
})

test("PunctuationClassification: single char", (t) => {
	const span = classifier.classify("@")
	t.same(span.classifications, ClassificationsMatchMap.from("punctuation"))
	t.end()
})

test("PunctuationClassification: multiple chars", (t) => {
	const span = classifier.classify("###&$%")
	t.same(span.classifications, ClassificationsMatchMap.from("punctuation"))
	t.end()
})

test("AlphaNumericClassification: English letter", (t) => {
	const span = classifier.classify("1A")
	t.same(span.classifications, ClassificationsMatchMap.from("alphanumeric"))
	t.end()
})

test("AlphaNumericClassification: English mixed-case word", (t) => {
	const span = classifier.classify("100 TesT ExAmPle")
	t.same(span.classifications, ClassificationsMatchMap.from("alphanumeric"))
	t.end()
})

test("AlphaNumericClassification: Japanese", (t) => {
	const span = classifier.classify("1東京")
	t.same(span.classifications, ClassificationsMatchMap.from("alphanumeric"))
	t.end()
})

test("AlphaNumericClassification: Mandarin", (t) => {
	const span = classifier.classify("北京市1")
	t.same(span.classifications, ClassificationsMatchMap.from("alphanumeric"))
	t.end()
})

test("AlphaNumericClassification: Cyrillic", (t) => {
	const span = classifier.classify("1Москва́")
	t.same(span.classifications, ClassificationsMatchMap.from("alphanumeric"))
	t.end()
})
