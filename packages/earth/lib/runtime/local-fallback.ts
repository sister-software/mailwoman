// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The browser pipeline as the local provider of a page that geocodes through the hosted API.
 *
 *   Such a page loads no model at first, so its cold load stays the basemap and the app bundle.
 *   When the hosted API fails or the device goes offline, the page mounts the browser runtime,
 *   and this provider answers once that runtime's release has loaded.
 */

import type { ParseResult } from "@mailwoman/core/pipeline/client-result"
import { type GeocoderProvider, ProviderPlacement } from "@mailwoman/geocoder-service"
import type { GeocoderRuntime, MapBias } from "@mailwoman/react/map"

import type { MemoryProfile } from "#memory/profile"

/**
 * The provider ID a browser answer reports.
 */
export const BROWSER_PROVIDER_ID = "browser"

/**
 * What the local provider reads from a query: the typed input and the map's viewport.
 */
export interface LocalFallbackQuery {
	input: string
	viewport: MapBias | null
}

/**
 * Whether a page may load the model as a fallback on this load.
 *
 * The profile is `null` until the crash guard's reading settles, and the page waits for it.
 * A tripped guard means an earlier load of this page ended during a heavy phase,
 * so the page keeps the hosted API as its only provider rather than load the model again.
 */
export function localFallbackPermitted(profile: MemoryProfile | null): boolean {
	return profile != null && !profile.crashGuard.tripped
}

/**
 * Where the page keeps the browser runtime it mounted for the fallback.
 *
 * The provider reads it at query time, outside React's render, so the slot is a plain object.
 * A component writes the runtime from an effect and clears it on unmount.
 */
export class BrowserRuntimeSlot {
	#runtime: GeocoderRuntime | null = null

	read = (): GeocoderRuntime | null => this.#runtime

	set = (runtime: GeocoderRuntime | null): void => {
		this.#runtime = runtime
	}
}

/**
 * The browser pipeline as a {@linkcode GeocoderProvider}.
 *
 * `readRuntime` answers the mounted browser runtime, or `null` before the page mounts one.
 * The provider is ready once that runtime's release has loaded.
 *
 * The engine's stage reports are dropped: the page shows the hosted API's stage labels,
 * and the browser pipeline's stage indexes refer to a different list.
 *
 * @typeParam A The answer type of the service's other provider.
 * @param toAnswer Wraps the pipeline's result in that answer type.
 */
export function createLocalFallbackProvider<Q extends LocalFallbackQuery, A>(
	readRuntime: () => GeocoderRuntime | null,
	toAnswer: (result: ParseResult) => A
): GeocoderProvider<Q, A> {
	return {
		id: BROWSER_PROVIDER_ID,
		placement: ProviderPlacement.Local,
		isReady: () => readRuntime()?.ready === true,
		geocode: async ({ input, viewport }) => {
			const runtime = readRuntime()

			if (!runtime?.ready) throw new Error("The browser geocoder has not loaded.")

			const hooks = { onStage: () => {} }

			const result = await (runtime.runParseWithBias
				? runtime.runParseWithBias(input, viewport, hooks)
				: runtime.runParse(input, hooks))

			return toAnswer(result)
		},
	}
}
