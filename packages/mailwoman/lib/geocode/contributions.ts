// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   How a data layer adds its services to a geocode session's generation scope.
 *
 *   A layer contributes one function.
 *   The function defines the layer's services on the scope, and tells the registrar
 *   which role each one serves.
 *
 *   An entry file lists the contributions of one environment, in the order the session consults them.
 */

import type { RegionDatabases } from "@mailwoman/core/resolver"
import type { ServiceRegistry, ServiceToken } from "async-init"

import type { GeocodeSessionOptions, GeocodeSessionSettings } from "#geocode/session"

/**
 * A rooftop source that answers for one country at a time, such as the national open registers.
 *
 * The scope disposes it with the session.
 */
export interface NationalDatabaseSource extends Disposable {
	for(country: string): RegionDatabases
}

/**
 * The street-tier databases of a region inside a country, keyed by the region's slug.
 *
 * A session reads it for an address whose tree states a region, such as a US state.
 * A `null` slug answers an empty bundle.
 */
export interface RegionDatabaseSource extends Disposable {
	readonly for: (regionSlug: string | null) => RegionDatabases
}

/**
 * What a contribution reads and writes while it registers a layer.
 */
export interface LayerRegistrar {
	/**
	 * The generation scope the layer defines its services on.
	 */
	readonly registry: ServiceRegistry
	readonly options: GeocodeSessionOptions
	readonly settings: GeocodeSessionSettings

	/**
	 * Adds a national rooftop source the layer defined on the scope.
	 *
	 * The session consults the sources in the order they were added.
	 * A source that fails to open is left out, and the session reports it as unavailable.
	 */
	nationalSource(token: ServiceToken<NationalDatabaseSource>): void
}

/**
 * Registers one layer's services on a generation scope.
 */
export type LayerContribution = (registrar: LayerRegistrar) => void

/**
 * A layer whose service failed to build, read by a service that declares it optional.
 */
export interface UnavailableLayer {
	/**
	 * The description of the layer's service token.
	 */
	layer: string
	/**
	 * What the layer's build threw.
	 */
	error: unknown
}

/**
 * The databases for a country from the first source that holds address points or street centroids for it.
 *
 * A country that no source covers reads the last source's answer, or an empty bundle
 * when there are no sources.
 */
export function firstCoveringSource(sources: readonly NationalDatabaseSource[]): (country: string) => RegionDatabases {
	return (country) => {
		let answer: RegionDatabases = {}

		for (const source of sources) {
			answer = source.for(country)

			if (answer.addressPoints || answer.streetCentroids) return answer
		}

		return answer
	}
}
