// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import test from "tape"
import { TextNormalizer } from "./normalizer.js"

test("normalizerr: hyphen", (t) => {
	const value = " Value-With-Some-Hyphen "
	const expected = "Value With Some Hyphen"
	const normalizer = new TextNormalizer({ removeHyphen: true })

	t.deepEquals(normalizer.normalize(value), expected)
	t.end()
})

test("normalizer: accents", (t) => {
	const value = " Vâlüé-Wìth-Sômê-Accents "
	const expected = "Value-With-Some-Accents"
	const normalizer = new TextNormalizer({ removeAccents: true })

	t.deepEquals(normalizer.normalize(value), expected)
	t.end()
})

test("normalizer: lowercase", (t) => {
	const value = "Value-With-Some-UpperCases"
	const expected = "value-with-some-uppercases"
	const normalizer = new TextNormalizer({ lowercase: true })

	t.deepEquals(normalizer.normalize(value), expected)
	t.end()
})

test("normalizer: spaces", (t) => {
	const value = "Value With Some Spaces"
	const expected = "ValueWithSomeSpaces"
	const normalizer = new TextNormalizer({ removeSpaces: true })

	t.deepEquals(normalizer.normalize(value), expected)
	t.end()
})

test("normalizer: option mix", (t) => {
	const value = "Vâlüé-Mìxèd"
	const expected = "value mixed"
	const normalizer = new TextNormalizer({ lowercase: true, removeHyphen: true, removeAccents: true })

	t.deepEquals(normalizer.normalize(value), expected)
	t.end()
})

test("normalizer: no options", (t) => {
	const value = "Value-With-Some-Hyphen"
	const normalizer = new TextNormalizer()

	t.deepEquals(normalizer.normalize(value), value)
	t.end()
})
