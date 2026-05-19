// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { Classification, Classifications, ClassifierSchemeCriteria, phraseMatchesScheme, Span } from "@mailwoman/core"
import { expect, test } from "vitest"

const PositiveMatchID = "PositiveMatch" as unknown as Classification
const NegativeMatchID = "NegativeMatch" as unknown as Classification

Classifications.add(PositiveMatchID)
Classifications.add(NegativeMatchID)

test("match: scheme.is multi-token", () => {
	const scheme: ClassifierSchemeCriteria = {
		is: [PositiveMatchID],
	}

	const phrase = Span.from("Test Phrase")
	expect(phraseMatchesScheme(scheme, phrase)).toBe(false)

	phrase.classifications.add(PositiveMatchID)
	expect(phraseMatchesScheme(scheme, phrase)).toBe(true)
})

test("match: scheme.is single-token", () => {
	const scheme: ClassifierSchemeCriteria = {
		is: [PositiveMatchID],
	}

	const phrase = Span.from("Test")
	expect(phraseMatchesScheme(scheme, phrase)).toBe(false)

	const child = Span.from("Test")
	phrase.children.add(child)

	child.classifications.add(PositiveMatchID)

	expect(phraseMatchesScheme(scheme, phrase)).toBe(true)
})

test("match: scheme.not multi-token", () => {
	const scheme: ClassifierSchemeCriteria = {
		is: [PositiveMatchID],
		classification: PositiveMatchID,
		not: [NegativeMatchID],
	}

	const phrase = Span.from("Test Phrase")
	expect(phraseMatchesScheme(scheme, phrase)).toBe(false)

	phrase.classifications.add(PositiveMatchID)

	expect(phraseMatchesScheme(scheme, phrase)).toBe(true)

	phrase.classifications.add(NegativeMatchID)

	expect(phraseMatchesScheme(scheme, phrase)).toBe(false)
})

test("match: scheme.not single-token", () => {
	const scheme: ClassifierSchemeCriteria = {
		is: [PositiveMatchID],
		not: [NegativeMatchID],
	}

	const phrase = Span.from("Test")
	expect(phraseMatchesScheme(scheme, phrase)).toBe(false)

	const child = Span.from("Test")
	phrase.children.add(child)

	child.classifications.add(PositiveMatchID)
	expect(phraseMatchesScheme(scheme, phrase)).toBe(true)

	child.classifications.add(NegativeMatchID)
	expect(phraseMatchesScheme(scheme, phrase)).toBe(false)
})
