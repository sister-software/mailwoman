// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The data layers a geocode session composes on Node, one contribution per layer.
 *
 *   A new layer adds its contribution here and to {@link NODE_LAYER_CONTRIBUTIONS}.
 *   The session and `#geocode/services` read the list and import no layer opener themselves.
 */

import { createToken, type ServiceToken } from "async-init"
import { resolvePath } from "path-ts"

import { openBANRegionDatabases } from "#geocode/ban-layers"
import type { LayerContribution, NationalDatabaseSource } from "#geocode/layer-contributions"
import { OvertureNationalDatabaseProvider } from "#geocode/national-overture"
import { openOSMRegionDatabases } from "#geocode/osm-layers"
import { USStateDatabaseProvider } from "#geocode/regions"
import { GenerationServices, ResolverModuleService } from "#geocode/services"
import { unattachedLayerLines } from "#geocode/serving-layers"
import { loadForkEntityDeps, loadLayerRoutes } from "#geocode/session/layers"
import { defineUnlessProvided } from "#services/define"

const S = GenerationServices

function disposeHandle(handle: Disposable | null | undefined): void {
	handle?.[Symbol.dispose]()
}

/**
 * The token of the national open-register (BAN) extracts.
 *
 * @public
 */
export const BANLayerService: ServiceToken<NationalDatabaseSource> = createToken("ban")

/**
 * The token of the national Overture address-point extracts.
 *
 * @public
 */
export const OvertureLayerService: ServiceToken<NationalDatabaseSource> = createToken("overture")

const banLayer: LayerContribution = ({ registry, options, nationalSource }) => {
	defineUnlessProvided(registry, BANLayerService, {
		needs: { selection: S.selection },
		build: ({ selection }) => openBANRegionDatabases(options.dataRoot, selection.catalog),
		release: disposeHandle,
	})

	nationalSource(BANLayerService)
}

const overtureLayer: LayerContribution = ({ registry, options, nationalSource }) => {
	defineUnlessProvided(registry, OvertureLayerService, {
		needs: { selection: S.selection },
		build: ({ selection }) => OvertureNationalDatabaseProvider.create(resolvePath(options.dataRoot), selection.catalog),
		release: disposeHandle,
	})

	nationalSource(OvertureLayerService)
}

// A refusal under MAILWOMAN_REFUSE_OBLIGATIONS isn't caught: it stops the session.
// Each extract the provider left unattached prints its path and reason to stderr,
// as the servers print it at startup.
const osmLayer: LayerContribution = ({ registry, options }) => {
	defineUnlessProvided(registry, S.osm, {
		needs: { selection: S.selection },
		build: async ({ selection }) => {
			const osm = await openOSMRegionDatabases(options.dataRoot, selection.catalog)

			for (const line of unattachedLayerLines({ osm })) {
				console.error(line)
			}

			return osm
		},
		release: disposeHandle,
	})
}

const usStateDatabases: LayerContribution = ({ registry, options }) => {
	defineUnlessProvided(registry, S.regionDatabases, {
		needs: { mod: ResolverModuleService, selection: S.selection },
		build: ({ mod, selection }) => USStateDatabaseProvider.create(mod, options.dataRoot, selection.catalog),
		release: disposeHandle,
	})
}

const forkEntityProbe: LayerContribution = ({ registry, options }) => {
	defineUnlessProvided(registry, S.forkEntity, {
		needs: { selection: S.selection },
		build: ({ selection }) => loadForkEntityDeps(options, selection.catalog),
		release: (probe) => disposeHandle(probe.handle),
	})
}

const observationRoutes: LayerContribution = ({ registry, options }) => {
	defineUnlessProvided(registry, S.layerRoutes, {
		needs: { selection: S.selection },
		build: ({ selection }) => loadLayerRoutes(options, selection.catalog),
		release: (routes) => {
			for (const route of Object.values(routes)) {
				disposeHandle(route)
			}
		},
	})
}

/**
 * Every layer a Node session composes.
 *
 * The national sources are consulted in this order: the open registers, then Overture.
 */
export const NODE_LAYER_CONTRIBUTIONS: readonly LayerContribution[] = [
	banLayer,
	overtureLayer,
	osmLayer,
	usStateDatabases,
	forkEntityProbe,
	observationRoutes,
]
