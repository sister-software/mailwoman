// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { Classification, Classifications, ClassifierSchemeCriteria, phraseMatchesScheme, Span } from "mailwoman/core"
import test from "tape"

const PositiveMatchID = "PositiveMatch" as unknown as Classification
const NegativeMatchID = "NegativeMatch" as unknown as Classification

Classifications.add(PositiveMatchID)
Classifications.add(NegativeMatchID)

test("match: scheme.is multi-token", (t) => {
	const scheme: ClassifierSchemeCriteria = {
		is: [PositiveMatchID],
	}

	const phrase = Span.from("Test Phrase")
	t.false(phraseMatchesScheme(scheme, phrase))

	phrase.classifications.add(PositiveMatchID)
	t.true(phraseMatchesScheme(scheme, phrase))

	t.end()
})

test("match: scheme.is single-token", (t) => {
	const scheme: ClassifierSchemeCriteria = {
		is: [PositiveMatchID],
	}

	const phrase = Span.from("Test")
	t.false(phraseMatchesScheme(scheme, phrase))

	const child = Span.from("Test")
	phrase.children.add(child)

	child.classifications.add(PositiveMatchID)

	t.true(phraseMatchesScheme(scheme, phrase))

	t.end()
})

test("match: scheme.not multi-token", (t) => {
	const scheme: ClassifierSchemeCriteria = {
		is: [PositiveMatchID],
		classification: PositiveMatchID,
		not: [NegativeMatchID],
	}

	const phrase = Span.from("Test Phrase")
	t.false(phraseMatchesScheme(scheme, phrase))

	phrase.classifications.add(PositiveMatchID)

	t.true(phraseMatchesScheme(scheme, phrase))

	phrase.classifications.add(NegativeMatchID)

	t.false(phraseMatchesScheme(scheme, phrase))

	t.end()
})

test("match: scheme.not single-token", (t) => {
	const scheme: ClassifierSchemeCriteria = {
		is: [PositiveMatchID],
		not: [NegativeMatchID],
	}

	const phrase = Span.from("Test")
	t.false(phraseMatchesScheme(scheme, phrase))

	const child = Span.from("Test")
	phrase.children.add(child)

	child.classifications.add(PositiveMatchID)
	t.true(phraseMatchesScheme(scheme, phrase))

	child.classifications.add(NegativeMatchID)
	t.false(phraseMatchesScheme(scheme, phrase))

	t.end()
})
