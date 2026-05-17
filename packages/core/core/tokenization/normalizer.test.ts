/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"
import { TextNormalizer } from "./normalizer.js"

test("normalizerr: hyphen", () => {
	const value = " Value-With-Some-Hyphen "
	const expected = "Value With Some Hyphen"
	const normalizer = new TextNormalizer({ removeHyphen: true })

	expect(normalizer.normalize(value)).toStrictEqual(expected)
})

test("normalizer: accents", () => {
	const value = " Vâlüé-Wìth-Sômê-Accents "
	const expected = "Value-With-Some-Accents"
	const normalizer = new TextNormalizer({ removeAccents: true })

	expect(normalizer.normalize(value)).toStrictEqual(expected)
})

test("normalizer: lowercase", () => {
	const value = "Value-With-Some-UpperCases"
	const expected = "value-with-some-uppercases"
	const normalizer = new TextNormalizer({ lowercase: true })

	expect(normalizer.normalize(value)).toStrictEqual(expected)
})

test("normalizer: spaces", () => {
	const value = "Value With Some Spaces"
	const expected = "ValueWithSomeSpaces"
	const normalizer = new TextNormalizer({ removeSpaces: true })

	expect(normalizer.normalize(value)).toStrictEqual(expected)
})

test("normalizer: option mix", () => {
	const value = "Vâlüé-Mìxèd"
	const expected = "value mixed"
	const normalizer = new TextNormalizer({ lowercase: true, removeHyphen: true, removeAccents: true })

	expect(normalizer.normalize(value)).toStrictEqual(expected)
})

test("normalizer: no options", () => {
	const value = "Value-With-Some-Hyphen"
	const normalizer = new TextNormalizer()

	expect(normalizer.normalize(value)).toStrictEqual(value)
})
