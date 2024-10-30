/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	AlphaClassification,
	AlphaNumericClassification,
	NumericClassification,
	PunctuationClassification,
} from "mailwoman/classification"
import test from "tape"
import AlphaNumericClassifier from "./AlphaNumericClassifier.js"

const classifier = new AlphaNumericClassifier()

test("AlphaClassification: English letter", (t) => {
	const span = classifier.classify("A")
	t.deepEqual(span.classifications, { AlphaClassification: new AlphaClassification(1.0) })
	t.end()
})

test("AlphaClassification: English mixed-case word", (t) => {
	const span = classifier.classify("TesT ExAmPle")
	t.deepEqual(span.classifications, { AlphaClassification: new AlphaClassification(1.0) })
	t.end()
})

test("AlphaClassification: Japanese", (t) => {
	const span = classifier.classify("東京")
	t.deepEqual(span.classifications, { AlphaClassification: new AlphaClassification(1.0) })
	t.end()
})

test("AlphaClassification: Mandarin", (t) => {
	const span = classifier.classify("北京市")
	t.deepEqual(span.classifications, { AlphaClassification: new AlphaClassification(1.0) })
	t.end()
})

test("AlphaClassification: Cyrillic", (t) => {
	const span = classifier.classify("Москва́")
	t.deepEqual(span.classifications, { AlphaClassification: new AlphaClassification(1.0) })
	t.end()
})

test("NumericClassification: single digit", (t) => {
	const span = classifier.classify("1")
	t.deepEqual(span.classifications, { NumericClassification: new NumericClassification(1.0) })
	t.end()
})

test("NumericClassification: multiple digits", (t) => {
	const span = classifier.classify("1234567890")
	t.deepEqual(span.classifications, { NumericClassification: new NumericClassification(1.0) })
	t.end()
})

test("PunctuationClassification: single char", (t) => {
	const span = classifier.classify("@")
	t.deepEqual(span.classifications, { PunctuationClassification: new PunctuationClassification(1.0) })
	t.end()
})

test("PunctuationClassification: multiple chars", (t) => {
	const span = classifier.classify("###&$%")
	t.deepEqual(span.classifications, { PunctuationClassification: new PunctuationClassification(1.0) })
	t.end()
})

test("AlphaNumericClassification: English letter", (t) => {
	const span = classifier.classify("1A")
	t.deepEqual(span.classifications, { AlphaNumericClassification: new AlphaNumericClassification(1.0) })
	t.end()
})

test("AlphaNumericClassification: English mixed-case word", (t) => {
	const span = classifier.classify("100 TesT ExAmPle")
	t.deepEqual(span.classifications, { AlphaNumericClassification: new AlphaNumericClassification(1.0) })
	t.end()
})

test("AlphaNumericClassification: Japanese", (t) => {
	const span = classifier.classify("1東京")
	t.deepEqual(span.classifications, { AlphaNumericClassification: new AlphaNumericClassification(1.0) })
	t.end()
})

test("AlphaNumericClassification: Mandarin", (t) => {
	const span = classifier.classify("北京市1")
	t.deepEqual(span.classifications, { AlphaNumericClassification: new AlphaNumericClassification(1.0) })
	t.end()
})

test("AlphaNumericClassification: Cyrillic", (t) => {
	const span = classifier.classify("1Москва́")
	t.deepEqual(span.classifications, { AlphaNumericClassification: new AlphaNumericClassification(1.0) })
	t.end()
})
