/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect } from "vitest"

/**
 * Assert that two items are deeply equal after JSON serialization.
 *
 * @param actual - The actual item.
 * @param expected - The expected item.
 * @param message - The message to display.
 */
export function assertDeepSerialized(
	actual: unknown,
	expected: unknown,
	message = "Items are deeply equally after serialization"
): void {
	expect(JSON.stringify(actual), message).toStrictEqual(JSON.stringify(expected))
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
 * Given two iterables, assert that they are congruent, i.e. that they have the same elements in the same order.
 */
export function assertCongruent<Item>(
	actualItemIterators: Iterable<Iterable<Item>>,
	...expectedItemIterators: Iterable<Item>[]
): void {
	const mergedIterators = zip(actualItemIterators, expectedItemIterators)

	for (const [actualItemIterator, expectedItemIterator, iteratorsIndex] of mergedIterators) {
		if (typeof expectedItemIterator === "undefined") {
			throw new Error(`Expected items at index ${iteratorsIndex} not found`)
		}

		if (typeof actualItemIterator === "undefined") {
			throw new Error(`Actual items at index ${iteratorsIndex} not found`)
		}

		const zipped = zip(actualItemIterator, expectedItemIterator)

		for (const [actualItem, expectedItem, itemIndex] of zipped) {
			expect(actualItem, `Item ${itemIndex} of iterator ${iteratorsIndex} matches`).toEqual(expectedItem)
		}

		expect(true, `All items match in iterator ${iteratorsIndex}`).toBe(true)
	}
}
