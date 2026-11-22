// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The default street-name evidence index for the user-facing parse surfaces: the rerank is
 *   positive-evidence-only, so it can add an atlas-confirmed street but never remove a model call.
 *
 *   The index is a service on a scope.
 *   The scope opens the database once and closes it at its disposal.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import type { StreetLocalityEvidence } from "@mailwoman/resolver"
import { createToken, optional, type ServiceRegistry, type ServiceToken } from "async-init"
import { resolvePath } from "path-ts"

import { defineUnlessProvided } from "#services/define"
import { registerResolverModuleService, ResolverModuleService } from "#services/resolver-module"

/**
 * The token of the bundled FR street-name index.
 *
 * It is `null` when `@mailwoman/resolver-wof-sqlite` or `street-centroids-fr.db` can't
 * be resolved, so the pipeline performs no rerank instead of throwing.
 *
 * @public
 */
export const StreetEvidenceService: ServiceToken<(StreetLocalityEvidence & Disposable) | null> =
	createToken("street-evidence")

/**
 * Registers the street-name index on `registry`, with the resolver module it is built from.
 *
 * The database opens when a caller first needs the service, and the scope closes it.
 */
export function registerStreetEvidenceService(registry: ServiceRegistry): void {
	registerResolverModuleService(registry)

	defineUnlessProvided(registry, StreetEvidenceService, {
		needs: { mod: optional(ResolverModuleService) },
		build: async ({ mod }) => {
			if (!mod) return null

			try {
				const { banDatabasePath } = await import("@mailwoman/ban/paths")
				const dbPath = banDatabasePath("street-centroids-fr.db")

				if (!(await pathExists(dbPath))) return null

				return new mod.SQLiteStreetNameLookup(resolvePath(dbPath))
			} catch {
				return null
			}
		},
	})
}
