// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The resolver module service: `@mailwoman/resolver-wof-sqlite`, an optional peer of this package.
 */

import { CommandError } from "@mailwoman/core/scripting/command"
import { createToken, type ServiceRegistry, type ServiceToken } from "async-init"

import { defineUnlessProvided } from "#services/define"

/**
 * The token of the resolver module.
 *
 * A geocode session's process scope holds it beside the classifier.
 * A service that opens a SQLite layer declares a need on it, optional when the layer is.
 *
 * A caller that builds its own scope registers a service under this token.
 *
 * @public
 */
export const ResolverModuleService: ServiceToken<typeof import("@mailwoman/resolver-wof-sqlite")> =
	createToken("resolver-module")

/**
 * Registers the resolver module on `registry`.
 *
 * The module is imported when a caller first needs the service.
 * Its build throws when the package isn't installed.
 */
export function registerResolverModuleService(registry: ServiceRegistry): void {
	defineUnlessProvided(registry, ResolverModuleService, {
		build: async () => {
			try {
				return await import("@mailwoman/resolver-wof-sqlite")
			} catch {
				throw new CommandError(
					"geocode requires `@mailwoman/resolver-wof-sqlite` to be installed. " +
						"Run `npm install @mailwoman/resolver-wof-sqlite` and try again."
				)
			}
		},
	})
}
