// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Defines a service on a scope only when no ancestor scope already provides it.
 */

import type { ServiceDefinition, ServiceNeeds, ServiceRegistry, ServiceToken } from "async-init"

/**
 * Defines `token` on `registry`, unless the registry or one of its ancestors already has a service for it.
 *
 * A child scope's definition would shadow its parent's, and the child's other
 * services would then read the child's.
 * Each registration function goes through this helper so that a parent scope's service wins
 * instead: a server's process scope supplies the classifier to every session,
 * and a test's scope substitutes a resolver backend or one data layer.
 *
 * The services that need the token read the parent's service, and the graph reports it as inherited.
 */
export function defineUnlessProvided<T, const N extends ServiceNeeds = Record<never, never>>(
	registry: ServiceRegistry,
	token: ServiceToken<T>,
	definition: ServiceDefinition<T, N>
): void {
	if (registry.has(token)) return

	registry.define(token, definition)
}
