// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { ClassificationRecord, createAddressParser } from "mailwoman"
import { Classification, Classifier, LibPostalLanguageCode } from "mailwoman/core"
import test from "tape"

/**
 * Global test parser instance.
 */
export const parser = createAddressParser({
	// languages: ["en"],
})

export function assert(input: string, ...expectedClassifications: ClassificationRecord[]): Promise<void> {
	const { resolve, promise } = Promise.withResolvers<void>()

	test(input, async (t) => {
		t.teardown(resolve)

		const solutions = await parser.parse(input)

		if (expectedClassifications.length === 0) {
			if (solutions.length !== 0) {
				t.deepEqual(solutions, [], "Expected no solutions.")
				t.end()

				return
			}

			t.pass("No solutions and no expected records.")
			t.end()

			return
		}
		for (let i = 0; i < expectedClassifications.length; i++) {
			const expectedClassification = expectedClassifications[i]
			const bestMatch = solutions[i]

			if (!bestMatch) {
				// t.fail(`Cannot find a match for expected record ${i}: ${JSON.stringify(expectedClassification)}.`)
				t.deepEqual(null, expectedClassification, `Match for expected record @ ${i}`)
				t.end()

				return
			}

			t.deepEqual(
				bestMatch.classifications,
				expectedClassification,
				`Classification record ${i + 1} of ${expectedClassifications.length} matches.`
			)
		}

		t.end()
	})

	return promise
}

/**
 * Assert that two items are deeply equal after JSON serialization.
 *
 * @param t - The test object.
 * @param actual - The actual item.
 * @param expected - The expected item.
 * @param message - The message to display.
 */
export function assertDeepSerialized(
	t: test.Test,
	actual: unknown,
	expected: unknown,
	message = "Items are deeply equally after serialization"
): void {
	t.equals(JSON.stringify(actual), JSON.stringify(expected), message)
}

/**
 * Given two iterables, zip them together into a single iterable which yields pairs of elements.
 *
 * If one iterable is longer than the other, the shorter iterable will be padded with `undefined`.
 */
export function* zip<T, U>(
	a: Iterable<T>,
	b: Iterable<U>
): Generator<[a: T | undefined, b: U | undefined, idx: number]> {
	const aIterator = a[Symbol.iterator]()
	const bIterator = b[Symbol.iterator]()

	let index = 0

	while (true) {
		const { done: aDone, value: aValue } = aIterator.next()
		const { done: bDone, value: bValue } = bIterator.next()

		if (aDone && bDone) {
			break
		}

		yield [aValue, bValue, index]

		index++
	}
}

/**
 * Given two iterables, assert that they are congruent, i.e. that they have the same elements in the
 * same order.
 */
export function assertCongruent<Item>(
	t: test.Test,
	actualItemIterators: Iterable<Iterable<Item>>,
	...expectedItemIterators: Iterable<Item>[]
): void {
	const mergedIterators = zip(actualItemIterators, expectedItemIterators)

	for (const [actualItemIterator, expectedItemIterator, iteratorsIndex] of mergedIterators) {
		if (typeof expectedItemIterator === "undefined") {
			t.fail(`Expected items at index ${iteratorsIndex} not found`)
			return
		}

		if (typeof actualItemIterator === "undefined") {
			t.fail(`Actual items at index ${iteratorsIndex} not found`)
			return
		}

		const zipped = zip(actualItemIterator, expectedItemIterator)

		for (const [actualItem, expectedItem, itemIndex] of zipped) {
			t.same(actualItem, expectedItem, `Item ${itemIndex} of iterator ${iteratorsIndex} matches`)
		}

		t.pass("All items match")
	}
}

export type ExpectedClassificationEntry = [input: string, Iterable<LibPostalLanguageCode>]

/**
 * Assert that a classifier correctly classifies a set of inputs.
 */
export function assertClassification(
	classifier: Classifier,
	classificationTarget: Classification,
	expectations: ExpectedClassificationEntry[]
) {
	if (typeof classifier.classify !== "function") {
		throw new TypeError(`Classifier ${classifier.constructor.name} does not implement the classify method`)
	}

	for (const [input, expectedLanguages] of expectations) {
		test(`classify: ${input}`, async (t) => {
			const actual = (await classifier.classify!(input)).classifications.get(classificationTarget)

			if (!actual) {
				t.fail(`"${input}" is not classified as ${classificationTarget}`)
				return
			}

			t.true(actual, `"${input}" is classified as ${classificationTarget}`)

			const expectedLanguageSet = new Set(expectedLanguages)
			if (expectedLanguageSet.size) {
				const actualLanguageSet = new Set(actual.languages)

				if (actualLanguageSet.isSupersetOf(expectedLanguageSet)) {
					t.pass(`"${input}" is classified as a given name in ${JSON.stringify(Array.from(expectedLanguageSet))}`)
				} else {
					t.fail(
						`Expected "${input}" to be classified in ${JSON.stringify(Array.from(expectedLanguageSet))} but only found in ${JSON.stringify(Array.from(actualLanguageSet))}`
					)
				}
			}

			t.end()
		})
	}
}
