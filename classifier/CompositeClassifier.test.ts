/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import test from "tape"
import { Classification, ClassifierSchemeCriteria } from "../classification/Classification.js"
import { Span } from "../tokenization/Span.js"
import CompositeClassifier from "./CompositeClassifier.js"

const classifier = new CompositeClassifier()

class PositiveClassification extends Classification {}
class NegativeClassification extends Classification {}

test("match: scheme.is multi-token", (t) => {
	const scheme = { is: ["PositiveClassification"] }

	const phrase = new Span("Test Phrase")
	t.false(classifier.match(scheme, phrase))

	phrase.classifications.PositiveClassification = new PositiveClassification()
	t.true(classifier.match(scheme, phrase))

	t.end()
})

test("match: scheme.is single-token", (t) => {
	const scheme = { is: ["PositiveClassification"] }

	const phrase = new Span("Test")
	t.false(classifier.match(scheme, phrase))

	const child = new Span("Test")
	phrase.graph.add("child", child)

	child.classifications.PositiveClassification = new PositiveClassification()
	t.true(classifier.match(scheme, phrase))

	t.end()
})

test("match: scheme.not multi-token", (t) => {
	const scheme: ClassifierSchemeCriteria = {
		is: ["PositiveClassification"],
		Class: PositiveClassification,
		not: ["NegativeClassification"],
	}

	const phrase = new Span("Test Phrase")
	t.false(classifier.match(scheme, phrase))

	phrase.classifications.PositiveClassification = new PositiveClassification()
	t.true(classifier.match(scheme, phrase))

	phrase.classifications.NegativeClassification = new NegativeClassification()
	t.false(classifier.match(scheme, phrase))

	t.end()
})

test("match: scheme.not single-token", (t) => {
	const scheme = { is: ["PositiveClassification"], not: ["NegativeClassification"] }

	const phrase = new Span("Test")
	t.false(classifier.match(scheme, phrase))

	const child = new Span("Test")
	phrase.graph.add("child", child)

	child.classifications.PositiveClassification = new PositiveClassification()
	t.true(classifier.match(scheme, phrase))

	child.classifications.NegativeClassification = new NegativeClassification()
	t.false(classifier.match(scheme, phrase))

	t.end()
})
