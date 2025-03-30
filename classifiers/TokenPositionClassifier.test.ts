// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { Span, TokenContext } from "mailwoman/core"
import test from "tape"
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

test("classify: empty string", (t) => {
	const c = classify("")

	t.equals(c.start_token.length, 0)
	t.equals(c.end_token.length, 0)
	t.equals(c.end_token_single_character.length, 0)
	t.end()
})

test("classify: A", (t) => {
	const c = classify("A")
	t.equals(c.start_token.length, 1)
	t.equals(c.start_token[0]!.body, "A")
	t.equals(c.end_token.length, 1)
	t.equals(c.end_token[0]!.body, "A")
	t.equals(c.end_token_single_character.length, 1)
	t.equals(c.end_token_single_character[0]!.body, "A")
	t.end()
})

test("classify: A B", (t) => {
	const c = classify("A B")
	t.equals(c.start_token.length, 1)
	t.equals(c.start_token[0]!.body, "A")
	t.equals(c.end_token.length, 1)
	t.equals(c.end_token[0]!.body, "B")
	t.equals(c.end_token_single_character.length, 1)
	t.equals(c.end_token_single_character[0]!.body, "B")
	t.end()
})

test("classify: A BC", (t) => {
	const c = classify("A BC")
	t.equals(c.start_token.length, 1)
	t.equals(c.start_token[0]!.body, "A")
	t.equals(c.end_token.length, 1)
	t.equals(c.end_token[0]!.body, "BC")
	t.equals(c.end_token_single_character.length, 0)
	t.end()
})

test("classify: A BC, D", (t) => {
	const c = classify("A BC, D")
	t.equals(c.start_token.length, 1)
	t.equals(c.start_token[0]!.body, "A")
	t.equals(c.end_token.length, 1)
	t.equals(c.end_token[0]!.body, "D")
	t.equals(c.end_token_single_character.length, 1)
	t.equals(c.end_token_single_character[0]!.body, "D")
	t.end()
})
