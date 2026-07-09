/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ClassificationsMatchMap } from "@mailwoman/core"
import { expect, test } from "vitest"

import { AlphaNumericClassifier } from "./AlphaNumericClassifier.ts"

const classifier = new AlphaNumericClassifier()

test("AlphaClassification: English letter", () => {
	const span = classifier.classify("A")

	expect(span.classifications).toEqual(ClassificationsMatchMap.from("alpha"))
})

test("AlphaClassification: English mixed-case word", () => {
	const span = classifier.classify("TesT ExAmPle")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("alpha"))
})

test("AlphaClassification: Japanese", () => {
	const span = classifier.classify("東京")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("alpha"))
})

test("AlphaClassification: Mandarin", () => {
	const span = classifier.classify("北京市")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("alpha"))
})

test("AlphaClassification: Cyrillic", () => {
	const span = classifier.classify("Москва́")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("alpha"))
})

test("NumericClassification: single digit", () => {
	const span = classifier.classify("1")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("numeric"))
})

test("NumericClassification: multiple digits", () => {
	const span = classifier.classify("1234567890")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("numeric"))
})

test("PunctuationClassification: single char", () => {
	const span = classifier.classify("@")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("punctuation"))
})

test("PunctuationClassification: multiple chars", () => {
	const span = classifier.classify("###&$%")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("punctuation"))
})

test("AlphaNumericClassification: English letter", () => {
	const span = classifier.classify("1A")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("alphanumeric"))
})

test("AlphaNumericClassification: English mixed-case word", () => {
	const span = classifier.classify("100 TesT ExAmPle")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("alphanumeric"))
})

test("AlphaNumericClassification: Japanese", () => {
	const span = classifier.classify("1東京")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("alphanumeric"))
})

test("AlphaNumericClassification: Mandarin", () => {
	const span = classifier.classify("北京市1")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("alphanumeric"))
})

test("AlphaNumericClassification: Cyrillic", () => {
	const span = classifier.classify("1Москва́")
	expect(span.classifications).toStrictEqual(ClassificationsMatchMap.from("alphanumeric"))
})
