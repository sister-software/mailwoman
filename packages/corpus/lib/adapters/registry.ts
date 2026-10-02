/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The lookup table that resolves an adapter id to its implementation.
 *
 * `mailwoman corpus run <adapter-id>` and the `corpus build` pipeline both resolve `<adapter-id>`
 * through this registry. Adapters do not self-register at module load; `adapters.ts` adds each one
 * explicitly, so the dependency graph stays traceable.
 */

import { stringifyJSON } from "@mailwoman/core/json"

import type { CorpusAdapter } from "#types"

/**
 * Lookup table for corpus adapters.
 */
export interface AdapterRegistry {
	/**
	 * Add an adapter.
	 *
	 * @throws If `adapter.id` is already registered.
	 */
	register(adapter: CorpusAdapter): void

	/**
	 * Return the adapter for `id`, or `undefined`.
	 */
	get(id: string): CorpusAdapter | undefined

	/**
	 * All registered adapters, in insertion order.
	 */
	list(): readonly CorpusAdapter[]

	/**
	 * Convenience: ids only, in insertion order.
	 */
	ids(): readonly string[]
}

/**
 * Default in-memory registry.
 *
 * The runner constructs one per invocation.
 * The CLI re-uses {@linkcode defaultAdapterRegistry}, which `adapters.ts` populates.
 */
export class InMemoryAdapterRegistry implements AdapterRegistry {
	#byID = new Map<string, CorpusAdapter>()

	register(adapter: CorpusAdapter): void {
		if (this.#byID.has(adapter.id)) {
			throw new Error(`AdapterRegistry: id ${stringifyJSON(adapter.id)} already registered`)
		}

		this.#byID.set(adapter.id, adapter)
	}

	get(id: string): CorpusAdapter | undefined {
		return this.#byID.get(id)
	}

	list(): readonly CorpusAdapter[] {
		return Array.from(this.#byID.values())
	}

	ids(): readonly string[] {
		return Array.from(this.#byID.keys())
	}
}

/**
 * Process-wide default registry, populated by `adapters.ts`.
 *
 * A test constructs its own {@linkcode InMemoryAdapterRegistry} rather than mutating this one.
 */
export const defaultAdapterRegistry = new InMemoryAdapterRegistry()
