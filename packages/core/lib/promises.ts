/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 */

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
