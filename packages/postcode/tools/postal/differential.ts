// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The comparison of the `postal` family's accepting countries with `countriesAcceptingPostcode`.
 *
 *   For one string, the two return the same list of countries: `acceptingCountries` trims
 *   the text and unites the countries of the whole-text recognitions of the `postal` family,
 *   and `countriesAcceptingPostcode` runs every country's `RegExp`.
 *   The module holds the comparison and the inputs it runs on, and the test,
 *   the real-row tool and the benchmark share it.
 */

import { mulberry32 } from "@mailwoman/core/random"
import { createRecognizer } from "@mailwoman/recognize"

import { countriesAcceptingPostcode } from "#country-formats"
import { acceptingCountries, postal } from "#recognize/postal"

/**
 * The recognizer the comparison runs: the `postal` family, with no other family composed.
 */
export const postalRecognizer = createRecognizer([postal])

/**
 * One input on which the two disagree.
 */
export interface AcceptingDifference {
	input: string
	/**
	 * `countriesAcceptingPostcode`, the serving implementation.
	 */
	expected: string[]
	/**
	 * `acceptingCountries` over the `postal` family.
	 */
	recognized: string[]
}

/**
 * Compares the two on `text`, and returns the difference or `null`.
 */
export function compareAccepting(text: string): AcceptingDifference | null {
	const expected = countriesAcceptingPostcode(text)
	const recognized = acceptingCountries(postalRecognizer, text)

	// oxlint-disable-next-line no-restricted-properties -- the comparison needs a canonical text of two sorted arrays of codes
	return JSON.stringify(expected) === JSON.stringify(recognized) ? null : { input: text, expected, recognized }
}

/**
 * Compares the two on every input and returns each difference.
 */
export function compareAll(inputs: Iterable<string>): { compared: number; differences: AcceptingDifference[] } {
	const differences: AcceptingDifference[] = []
	let compared = 0

	for (const input of inputs) {
		compared++

		const difference = compareAccepting(input)

		if (difference) {
			differences.push(difference)
		}
	}

	return { compared, differences }
}

/**
 * Strings built from `alphabet`, every one of up to `maxLength` characters.
 */
export function* enumerateStrings(alphabet: readonly string[], maxLength: number): Generator<string> {
	let layer = [""]

	yield ""

	for (let length = 1; length <= maxLength; length++) {
		const next: string[] = []

		for (const prefix of layer) {
			for (const character of alphabet) {
				const text = prefix + character

				next.push(text)

				yield text
			}
		}

		layer = next
	}
}

/**
 * The characters the generated inputs draw on: digits, letters in both cases,
 * white space and the separators of the printed forms.
 */
export const DENSE_ALPHABET = [..."0123456789ABCSKXZIL -\t"]

/**
 * `count` strings of 1 to `maxLength` characters drawn from `alphabet` by a seeded generator.
 */
export function* randomStrings(
	alphabet: readonly string[],
	count: number,
	maxLength: number,
	seed: number
): Generator<string> {
	const next = mulberry32(seed)

	for (let index = 0; index < count; index++) {
		const length = 1 + Math.floor(next() * maxLength)
		let text = ""

		for (let position = 0; position < length; position++) {
			text += alphabet[Math.floor(next() * alphabet.length)]!
		}

		yield text
	}
}

/**
 * Inputs built to probe the digit and case rules, where JavaScript's `iu` flags and the
 * compiler's parser could part: fullwidth and other non-ASCII digits, the Kelvin sign and the
 * long s under case folding, the dotless i, combining marks, and white space of every width.
 */
export function probeInputs(examples: readonly string[]): string[] {
	const probes = new Set<string>()

	const swaps: ReadonlyArray<readonly [string, string]> = [
		["0", "０"],
		["1", "١"],
		["2", "٢"],
		["3", "٣"],
		["K", "K"],
		["k", "K"],
		["S", "ſ"],
		["s", "ſ"],
		["I", "ı"],
		["i", "ı"],
		[" ", " "],
		[" ", "　"],
		[" ", " "],
		[" ", "\u0085"],
		[" ", "﻿"],
		["-", "‐"],
		["-", "−"],
	]

	for (const example of examples) {
		probes.add(example)
		probes.add(`${example}́`)
		probes.add(`́${example}`)
		probes.add(` ${example}\t`)
		probes.add(` ${example}　`)
		probes.add(`${example}​`)
		probes.add(example.toLowerCase())

		for (const [from, to] of swaps) {
			let index = example.indexOf(from)

			while (index >= 0) {
				probes.add(example.slice(0, index) + to + example.slice(index + from.length))

				index = example.indexOf(from, index + 1)
			}
		}
	}

	return [...probes]
}
