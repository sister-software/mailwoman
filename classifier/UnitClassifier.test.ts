/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { UnitClassification } from "mailwoman/classification"
import test from "tape"
import { Span } from "../tokenization/Span.js"
import { UnitClassifier } from "./UnitClassifier.js"

const classifier = new UnitClassifier()

test("number without unit type", (t) => {
	const span = classifier.classify("2020")
	t.deepEqual(span.classifications, {})
	t.end()
})

test("letter without unit type", (t) => {
	const span = classifier.classify("alpha")
	t.deepEqual(span.classifications, {})
	t.end()
})

test("number and letter without unit type", (t) => {
	const span = classifier.classify("2020a")
	t.deepEqual(span.classifications, {})
	t.end()
})

test("letter and number without unit type", (t) => {
	const span = classifier.classify("a2")
	t.deepEqual(span.classifications, {})
	t.end()
})

test("single letter without unit type", (t) => {
	const span = classifier.classify("a")
	t.deepEqual(span.classifications, {})
	t.end()
})

test("number with # without unit type", (t) => {
	const span = classifier.classify("#22")
	t.deepEqual(span.classifications, {})
	t.end()
})

test("number with # without unit type with prev token", (t) => {
	const span = new Span("#22")
	const previous = new Span("prev")
	span.graph.add("prev", previous)
	classifier.each(span)
	t.deepEqual(span.classifications, { UnitClassification: new UnitClassification(1.0) })
	t.end()
})

test("number with unit type", (t) => {
	const span = classifier.classify("2020", "unit")
	t.deepEqual(span.classifications, { UnitClassification: new UnitClassification(1.0) })
	t.end()
})

test("letters with unit type", (t) => {
	const span = classifier.classify("alpha", "unit")
	t.deepEqual(span.classifications, {})
	t.end()
})

test("number and letter with unit type", (t) => {
	const span = classifier.classify("2020a", "unit")
	t.deepEqual(span.classifications, { UnitClassification: new UnitClassification(1.0) })
	t.end()
})

test("letter and number with unit type", (t) => {
	const span = classifier.classify("a2", "unit")
	t.deepEqual(span.classifications, { UnitClassification: new UnitClassification(1.0) })
	t.end()
})

test("single letter with unit type", (t) => {
	const span = classifier.classify("a", "unit")
	t.deepEqual(span.classifications, { UnitClassification: new UnitClassification(1.0) })
	t.end()
})

test("number with # with unit type", (t) => {
	const span = classifier.classify("#22", "unit")
	t.deepEqual(span.classifications, { UnitClassification: new UnitClassification(1.0) })
	t.end()
})
