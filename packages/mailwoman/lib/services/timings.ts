// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Per-service build timings read from an `async-init` `ServiceRegistry`'s events.
 */

import type { ServiceRegistry } from "async-init"

/**
 * Wall-clock milliseconds of each service's own work, keyed by its token's description.
 *
 * The registry starts a service's clock after the services it needs have resolved,
 * so a figure excludes the wait for another service.
 * Services resolve in parallel, so the figures overlap and do not sum to a scope's total.
 */
export type ServiceTimings = Record<string, number>

/**
 * Writes the duration of each service `registry` builds into `timings`.
 *
 * A registry reports its own services only.
 * A session built on a shared process scope therefore records its generation services,
 * and the classifier that scope already loaded has no entry.
 *
 * Dispose the returned subscription to stop recording.
 * The registry also drops it when the registry itself is disposed.
 */
export function recordServiceTimings(registry: ServiceRegistry, timings: ServiceTimings): Disposable {
	return registry.subscribe((event) => {
		if (event.type === "resolve-end") {
			timings[event.token.description] = event.durationMs
		}
	})
}
