/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdirSync } from "node:fs"

import type { Alpha3bLanguageCode } from "@mailwoman/core/resources/languages"
import { dirname } from "path-ts"

import { PlacetypeDataSource, type PlacetypeDataSourceOptions } from "./PlacetypeDataSource.ts"
import type { WhosOnFirstPlacetype } from "./placetypes/definition.ts"

export { tryWithBackoff } from "./backoff.ts"

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
