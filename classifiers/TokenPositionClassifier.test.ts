/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Span, TokenContext } from "@mailwoman/core"
import { expect, test } from "vitest"
import { TokenPositionClassifier } from "./TokenPositionClassifier.js"

const classifier = new TokenPositionClassifier()

function classify(body: string) {
	const t = new TokenContext(body)
	classifier.classifyTokens(t)

	const end_token: Span[] = []
	const end_token_single_character: Span[] = []
	const start_token: Span[] = []

	t.sections.forEach((s) => {
		s.children.forEach((c) => {
			if (c.is("start_token")) {
				start_token.push(c)
			}
			if (c.is("end_token")) {
				end_token.push(c)
			}
			if (c.is("end_token_single_character")) {
				end_token_single_character.push(c)
			}
		})
	})

	return {
		start_token,
		end_token,
		end_token_single_character,
	}
}

test("classify: empty string", () => {
	const c = classify("")

	expect(c.start_token.length).toEqual(0)
	expect(c.end_token.length).toEqual(0)
	expect(c.end_token_single_character.length).toEqual(0)
})

test("classify: A", () => {
	const c = classify("A")
	expect(c.start_token.length).toEqual(1)
	expect(c.start_token[0]!.body).toEqual("A")
	expect(c.end_token.length).toEqual(1)
	expect(c.end_token[0]!.body).toEqual("A")
	expect(c.end_token_single_character.length).toEqual(1)
	expect(c.end_token_single_character[0]!.body).toEqual("A")
})

test("classify: A B", () => {
	const c = classify("A B")
	expect(c.start_token.length).toEqual(1)
	expect(c.start_token[0]!.body).toEqual("A")
	expect(c.end_token.length).toEqual(1)
	expect(c.end_token[0]!.body).toEqual("B")
	expect(c.end_token_single_character.length).toEqual(1)
	expect(c.end_token_single_character[0]!.body).toEqual("B")
})

test("classify: A BC", () => {
	const c = classify("A BC")
	expect(c.start_token.length).toEqual(1)
	expect(c.start_token[0]!.body).toEqual("A")
	expect(c.end_token.length).toEqual(1)
	expect(c.end_token[0]!.body, ").toEqual(BC")
	expect(c.end_token_single_character.length).toEqual(0)
})

test("classify: A BC, D", () => {
	const c = classify("A BC, D")
	expect(c.start_token.length).toEqual(1)
	expect(c.start_token[0]!.body).toEqual("A")
	expect(c.end_token.length).toEqual(1)
	expect(c.end_token[0]!.body).toEqual("D")
	expect(c.end_token_single_character.length).toEqual(1)
	expect(c.end_token_single_character[0]!.body).toEqual("D")
})
