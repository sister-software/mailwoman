/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import "core-js/actual/disposable-stack/index.js"

import type { Alpha3bLanguageCode } from "@mailwoman/core/resources/languages"
import { mkdirSync } from "node:fs"
import { setTimeout } from "node:timers/promises"
import { dirname } from "path-ts"
import { PlacetypeDataSource, type PlacetypeDataSourceOptions } from "./PlacetypeDataSource.js"
import type { WhosOnFirstPlacetype } from "./placetypes/definition.js"

export class DataSourceCache extends DisposableStack {
	#placetypeToLanguage = new Map<WhosOnFirstPlacetype, Map<Alpha3bLanguageCode, PlacetypeDataSource>>()

	public override [Symbol.toStringTag] = "DataSourceCache"

	public override [Symbol.dispose]() {
		super[Symbol.dispose]()

		this.#placetypeToLanguage.clear()
	}

	public open({ placetype, languageCode, dataDirectory }: PlacetypeDataSourceOptions): PlacetypeDataSource {
		let languageToDataSource = this.#placetypeToLanguage.get(placetype)

		if (!languageToDataSource) {
			languageToDataSource = new Map()
			this.#placetypeToLanguage.set(placetype, languageToDataSource)
		}

		let dataSource = languageToDataSource.get(languageCode)

		if (dataSource) return dataSource

		const databasePath = PlacetypeDataSource.createPath({ placetype, languageCode, dataDirectory }).toString()

		mkdirSync(dirname(databasePath), { recursive: true })

		dataSource = new PlacetypeDataSource(databasePath)

		languageToDataSource.set(languageCode, dataSource)

		return dataSource
	}
}

/**
 * Given a callback, attempt to run it up to `attempts` times.
 */
export async function tryWithBackoff<T>(attempts: number, callback: () => T): Promise<T> {
	let lastError: unknown

	for (let i = 0; i < attempts; i++) {
		try {
			const result = await callback()

			return result
		} catch (error) {
			lastError = error
		}

		// We try to avoid contention by giving a pause between attempts.
		const delay = Math.floor(Math.random() * 1000) + 1000 * attempts
		await setTimeout(delay)
	}

	throw lastError
}
