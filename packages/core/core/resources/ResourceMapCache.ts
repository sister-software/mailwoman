/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * A resource that can be disposed of either synchronously or asynchronously.
 */
export type DisposableLike = Disposable | AsyncDisposable

export type ResourceConstructor<K extends PropertyKey, R extends DisposableLike> = new (key: K) => R
export type ResourceFactory<K extends PropertyKey, R extends DisposableLike> = (key: K) => R | Promise<R>

export type ResourceFactoryLike<K extends PropertyKey = PropertyKey, R extends DisposableLike = DisposableLike> =
	| ResourceConstructor<K, R>
	| ResourceFactory<K, R>

export type InferResource<F> =
	F extends ResourceConstructor<infer _K, infer R> ? R : F extends ResourceFactory<infer _K, infer R> ? R : never

export type OpenResourceResult<F> =
	F extends ResourceConstructor<infer _K, infer R>
		? R
		: F extends ResourceFactory<infer _K, infer _R>
			? ReturnType<F>
			: never

/**
 * Type-guard to determine if a function is a constructor.
 */
function isConstructor<T>(value: unknown): value is T {
	if (typeof value !== "function") return false
	return Boolean(value.prototype && value.prototype.constructor === value)
}

/**
 * Type-guard to determine if a value is a promise-like object.
 */
export function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
	if (typeof value !== "object" || value === null) return false
	return typeof (value as PromiseLike<T>).then === "function"
}

/**
 * A map-like object that caches disposable resources, creating them on demand.
 */
export class ResourceMapCache<
		K extends PropertyKey = PropertyKey,
		R extends DisposableLike = DisposableLike,
		F extends ResourceFactoryLike<K, R> = ResourceConstructor<K, R>,
	>
	extends Map<K, R>
	implements AsyncDisposable
{
	/**
	 * The human-readable name of the resource.
	 */
	public displayName: string = "ResourceMapCache"

	constructor(ResourceConstructor: ResourceConstructor<K, R>)
	constructor(factory: ResourceFactory<K, R>)
	constructor(protected readonly factoryLike: F) {
		super()
	}

	/**
	 * Gets a resource from the cache, creating if it doesn't exist.
	 */
	public open(key: K): OpenResourceResult<F> {
		const existingResource = super.get(key)

		if (existingResource) return existingResource as OpenResourceResult<F>

		if (isConstructor<ResourceConstructor<K, R>>(this.factoryLike)) {
			const resource = new this.factoryLike(key)

			super.set(key, resource)

			return resource as OpenResourceResult<F>
		}

		const factoryResult = this.factoryLike(key)

		if (isPromiseLike(factoryResult)) {
			return factoryResult.then((resolvedResource) => {
				super.set(key, resolvedResource)

				return resolvedResource
			}) as OpenResourceResult<F>
		}

		super.set(key, factoryResult)

		return factoryResult as OpenResourceResult<F>
	}

	/**
	 * Closes a resource and removes it from the cache.
	 */
	public close(key: K): void {
		const resource = super.get(key)

		if (resource && Symbol.dispose in resource) {
			resource[Symbol.dispose]()
		}

		super.delete(key)
	}

	public async [Symbol.asyncDispose]() {
		const resourceKeys = Array.from(super.keys()).reverse()

		for (const resourceKey of resourceKeys) {
			this.close(resourceKey)
		}

		super.clear()
	}
}
