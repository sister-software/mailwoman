// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A Workbox plugin that answers 404 when a strategy has no cached copy
 *   and the network fails, as on a device that's offline.
 *
 *   MapLibre treats a 404 tile as one that doesn't exist: it fires no error event,
 *   and it draws the nearest loaded parent or child tile in its place.
 *   A failed fetch instead reaches the map as an error, and MapLibre logs one for every tile it requests.
 */

import type { WorkboxPlugin } from "workbox-core/types.js"

/**
 * The header that marks a 404 this plugin produced, so a reader can tell it from a 404 the origin sent.
 */
export const UNREACHABLE_HEADER = "x-mailwoman-unreachable"

/**
 * The plugin.
 *
 * Its `handlerDidError` runs only after the strategy found no cached copy and the request
 * failed, so a cached tile and a tile the network serves are unaffected.
 * The 404 it returns is never stored.
 */
export function missingWhenUnreachablePlugin(): WorkboxPlugin {
	return {
		handlerDidError: async () =>
			new Response(null, {
				status: 404,
				statusText: "Not cached, and the network is unreachable",
				headers: { [UNREACHABLE_HEADER]: "1" },
			}),
	}
}
