// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The interface a geocoder engine implements for {@linkcode GeocoderService}.
 */

/**
 * Where a provider's engine runs.
 */
export const ProviderPlacement = {
	/**
	 * The engine runs on a server, and each query is a network request.
	 */
	Remote: "remote",
	/**
	 * The engine runs on the device from assets it has already loaded,
	 * so a query needs no network once they're.
	 */
	Local: "local",
} as const

export type ProviderPlacement = (typeof ProviderPlacement)[keyof typeof ProviderPlacement]

/**
 * What a provider receives with each query.
 */
export interface GeocodeAttempt {
	/**
	 * Aborts when the caller cancels the query or the service's remote deadline passes.
	 */
	signal: AbortSignal

	/**
	 * Reports the index of the stage the engine has reached, for a progress display.
	 */
	onStage: (stage: number) => void
}

/**
 * One geocoder engine: a hosted API client, or the in-browser pipeline.
 *
 * A provider answers a query, and `GeocoderService` decides when to ask it.
 * The provider caches only what its engine needs, and the service worker caches
 * the assets and responses an engine fetches.
 *
 * @typeParam Q The query type.
 * @typeParam A The answer type. Both providers given to one service answer with the same type.
 */
export interface GeocoderProvider<Q, A> {
	/**
	 * A label for the provider, such as the API host or `browser`, reported with each answer.
	 */
	readonly id: string

	readonly placement: ProviderPlacement

	/**
	 * Whether the provider can answer a query now.
	 *
	 * A local provider is ready once its model and gazetteer assets have loaded.
	 * A remote provider is ready when it is configured, and the service reads the
	 * connectivity reading separately to decide whether to send it a query.
	 */
	isReady(): boolean

	/**
	 * Answers one query, or rejects.
	 */
	geocode(query: Q, attempt: GeocodeAttempt): Promise<A>
}
