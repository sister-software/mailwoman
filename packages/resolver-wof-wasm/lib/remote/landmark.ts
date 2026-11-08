// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The landmark route's interface: the Worker answers it, and a browser reads it through
 *   {@linkcode RemoteLandmarkLookup}.
 */

import type { LandmarkHit, LandmarkLookup } from "@mailwoman/core/resolver"

/**
 * The layers the route reads.
 */
export const LandmarkSource = {
	Wikidata: "wikidata",
	OpenStreetMap: "openstreetmap",
} as const

export type LandmarkSource = (typeof LandmarkSource)[keyof typeof LandmarkSource]

/**
 * The route's path on the Worker.
 */
export const LANDMARK_ROUTE = "/v1/landmarks"

/**
 * One answer from the route.
 */
export interface LandmarkRouteResponse {
	hits: LandmarkHit[]
	source: LandmarkSource
	/**
	 * The credit the layer's license requires beside anything drawn from these hits.
	 */
	attribution: string
	license: string
}

/**
 * Reads one layer through the landmark route.
 *
 * A failed request throws, because an empty answer would claim the layer holds no place of that name.
 */
export class RemoteLandmarkLookup implements LandmarkLookup {
	readonly #routeURL: URL

	readonly #source: LandmarkSource

	constructor(baseURL: URL, source: LandmarkSource) {
		this.#routeURL = new URL(LANDMARK_ROUTE, baseURL)
		this.#source = source
	}

	async find(name: string): Promise<LandmarkHit[]> {
		const url = new URL(this.#routeURL)

		url.searchParams.set("name", name)
		url.searchParams.set("source", this.#source)

		const response = await fetch(url)

		if (!response.ok) throw new Error(`The ${this.#source} landmark route answered ${response.status}`)

		const { hits } = (await response.json()) as LandmarkRouteResponse

		return hits
	}
}
