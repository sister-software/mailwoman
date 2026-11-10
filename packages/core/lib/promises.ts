/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 */

import { Service } from "async-init"

/**
 * Marks a promise started ahead of the await that reads it as handled, and returns it unchanged.
 *
 * A rejection still reaches the later await.
 * Before that await, or when the result goes unused, it is not reported as unhandled.
 */
export function startEarly<T>(promise: Promise<T>): Promise<T> {
	promise.catch(() => {})

	return promise
}

/**
 * Memoizes a zero-argument async load as its in-flight promise, so concurrent callers share one call.
 *
 * A resolved value stays cached.
 * A rejection clears the memo, so the next call loads again rather than receiving
 * the same failure for the rest of the process or page.
 *
 * The memo is an `async-init` `Service`, the lazy handle `FamilyBundles` keeps one of per weights family.
 * The value sits in a box, because a `Service` holds objects only and calls the
 * lifecycle hooks of an object that declares them.
 */
export function memoizeResettable<T>(load: () => Promise<T>): () => Promise<T> {
	const service = new Service(async () => ({ value: await load() }))

	return () => service.resolve().then((box) => box.value)
}

/**
 * Await every enumerable own property of an object while preserving its keys.
 */
type AwaitedObject<T extends object> = {
	-readonly [K in keyof T]: Awaited<T[K]>
}

/**
 * Await every enumerable own property of an object while preserving its keys.
 *
 * Polyfill for the Stage 3 `Promise.allKeyed` proposal.
 */
export async function allKeyed<const T extends object>(promisesObject: T): Promise<AwaitedObject<T>> {
	const keys = Reflect.ownKeys(promisesObject).filter((key) =>
		Object.prototype.propertyIsEnumerable.call(promisesObject, key)
	) as (keyof T)[]

	const values = await Promise.all(keys.map((key) => promisesObject[key]))

	const result = Object.create(null) as AwaitedObject<T>

	for (let index = 0; index < keys.length; index++) {
		const key = keys[index]!

		Object.defineProperty(result, key, {
			value: values[index],
			writable: true,
			enumerable: true,
			configurable: true,
		})
	}

	return result
}
