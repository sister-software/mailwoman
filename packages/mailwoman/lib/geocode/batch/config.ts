// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The serializable configuration a bulk geocode builds its sessions from, and the build.
 *
 * A worker thread receives the configuration by structured clone, so it holds only values a JSON file can hold.
 * A caller on the calling thread builds the same sessions from the same configuration.
 */

import type { z } from "zod"

import { createGeocodeSessionOptions, type GeocodeFileOptionsSchema, type SessionOptionSource } from "#geocode/options"
import { createRoutedGeocodeSessions, type GeocodeRouting, type RoutedGeocodeSessions } from "#geocode/session/routes"

/**
 * The sessions a bulk geocode runs: the session options, the data root,
 * and the locale each country parses under.
 */
export interface GeocodeBatchConfig {
	/**
	 * The data root the sessions read their databases and weights overlay from.
	 */
	dataRoot: string

	/**
	 * The session options, as a config file's `geocode` key states them.
	 *
	 * Every option left out takes its default.
	 */
	session?: z.input<typeof GeocodeFileOptionsSchema>

	/**
	 * Where `session.locale` came from, as the caller that built this config knows it.
	 *
	 * Omitted, a stated locale is recorded as the caller's and an omitted one as the default.
	 */
	localeSource?: SessionOptionSource

	/**
	 * The weights locale each country's inputs parse under, keyed by ISO 3166-1 alpha-2 country.
	 */
	localeByCountry?: Readonly<Record<string, string>>
}

/**
 * Builds the routed sessions a configuration describes.
 *
 * @param routing The routing hooks a caller on the calling thread may add.
 * A worker can't receive them.
 * @throws {z.ZodError} When a session option has the wrong type or isn't an option.
 */
export function createBatchGeocodeSessions(
	config: GeocodeBatchConfig,
	routing: Omit<GeocodeRouting, "localeByCountry"> = {}
): RoutedGeocodeSessions {
	return createRoutedGeocodeSessions(
		createGeocodeSessionOptions({
			...config.session,
			dataRoot: config.dataRoot,
			...(config.localeSource ? { localeSource: config.localeSource } : {}),
		}),
		{ ...routing, ...(config.localeByCountry ? { localeByCountry: config.localeByCountry } : {}) }
	)
}
