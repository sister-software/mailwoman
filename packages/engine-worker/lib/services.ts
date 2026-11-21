// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The engine Worker's services, on one `async-init` registry per isolate.
 *
 *   The release pipeline loads on the first request that parses, and every later
 *   request in the isolate reads the same one.
 *   A load that fails is forgotten, so the next request tries again.
 *
 *   The Worker never disposes the registry, because the platform ends an isolate without notice.
 */

import { createToken, ServiceRegistry, type ServiceToken } from "async-init"

import type { ReleasePipeline } from "#engine"
import { loadDefaultReleasePipeline } from "#release-pipeline"

/**
 * The token of the loaded parse stack of the default release.
 */
export const ReleasePipelineService: ServiceToken<ReleasePipeline> = createToken("release-pipeline")

/**
 * Defines the Worker's services on a new registry.
 */
export function createEngineScope(): ServiceRegistry {
	const scope = new ServiceRegistry()

	scope.define(ReleasePipelineService, { build: () => loadDefaultReleasePipeline() })

	return scope
}

let isolateScope: ServiceRegistry | null = null

/**
 * The isolate's registry, created on the first request.
 */
export function engineScope(): ServiceRegistry {
	return (isolateScope ??= createEngineScope())
}
