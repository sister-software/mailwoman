/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import test from "tape"
import { Span } from "../tokenization/Span.js"
import { Tokenizer } from "../tokenization/Tokenizer.js"
import TokenPositionClassifier from "./TokenPositionClassifier.js"

const classifier = new TokenPositionClassifier()

function classify(body: string) {
	const t = new Tokenizer(body)
	classifier.classifyTokenizer(t)

	// generate an array containing all the spans
	// with a final token classification
	const classifications: {
		EndTokenClassification: Span[]
		EndTokenSingleCharacterClassification: Span[]
		StartTokenClassification: Span[]
	} = {
		EndTokenClassification: [],
		EndTokenSingleCharacterClassification: [],
		StartTokenClassification: [],
	}

	t.section.forEach((s) => {
		s.graph.findAll("child").forEach((c) => {
			if (c.classifications.hasOwnProperty("StartTokenClassification")) {
				classifications.StartTokenClassification.push(c)
			}
			if (c.classifications.hasOwnProperty("EndTokenClassification")) {
				classifications.EndTokenClassification.push(c)
			}
			if (c.classifications.hasOwnProperty("EndTokenSingleCharacterClassification")) {
				classifications.EndTokenSingleCharacterClassification.push(c)
			}
		})
	})
	return classifications
}

test("classify: empty string", (t) => {
	const c = classify("")
	t.equals(c.StartTokenClassification.length, 0)
	t.equals(c.EndTokenClassification.length, 0)
	t.equals(c.EndTokenSingleCharacterClassification.length, 0)
	t.end()
})

test("classify: A", (t) => {
	const c = classify("A")
	t.equals(c.StartTokenClassification.length, 1)
	t.equals(c.StartTokenClassification[0]!.body, "A")
	t.equals(c.EndTokenClassification.length, 1)
	t.equals(c.EndTokenClassification[0]!.body, "A")
	t.equals(c.EndTokenSingleCharacterClassification.length, 1)
	t.equals(c.EndTokenSingleCharacterClassification[0]!.body, "A")
	t.end()
})

test("classify: A B", (t) => {
	const c = classify("A B")
	t.equals(c.StartTokenClassification.length, 1)
	t.equals(c.StartTokenClassification[0]!.body, "A")
	t.equals(c.EndTokenClassification.length, 1)
	t.equals(c.EndTokenClassification[0]!.body, "B")
	t.equals(c.EndTokenSingleCharacterClassification.length, 1)
	t.equals(c.EndTokenSingleCharacterClassification[0]!.body, "B")
	t.end()
})

test("classify: A BC", (t) => {
	const c = classify("A BC")
	t.equals(c.StartTokenClassification.length, 1)
	t.equals(c.StartTokenClassification[0]!.body, "A")
	t.equals(c.EndTokenClassification.length, 1)
	t.equals(c.EndTokenClassification[0]!.body, "BC")
	t.equals(c.EndTokenSingleCharacterClassification.length, 0)
	t.end()
})

test("classify: A BC, D", (t) => {
	const c = classify("A BC, D")
	t.equals(c.StartTokenClassification.length, 1)
	t.equals(c.StartTokenClassification[0]!.body, "A")
	t.equals(c.EndTokenClassification.length, 1)
	t.equals(c.EndTokenClassification[0]!.body, "D")
	t.equals(c.EndTokenSingleCharacterClassification.length, 1)
	t.equals(c.EndTokenSingleCharacterClassification[0]!.body, "D")
	t.end()
})
